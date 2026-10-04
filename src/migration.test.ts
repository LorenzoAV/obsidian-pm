import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import { makeFakeApp } from '#test/fakeVault'
import { migrateBoardCardConfig, migrateProjectLayout, migrateTaskRefs, migrateProjectNesting } from './migration'
import type PMPlugin from './main'
import { ProjectStore, VaultIndex } from './store'
import { DEFAULT_SETTINGS, makeDefaultFilter, makeDefaultGroup, makeDefaultSort, type PMSettings } from '@dotpm/core'

const expectDefined = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('expected value to be defined')
  return value
}

const projectNote = (id: string, title: string): string =>
  ['---', 'pm-project: true', `id: ${id}`, `title: ${title}`, 'taskIds:', '  - t1', '---', ''].join('\n')

const taskNote = (id: string, title: string, projectId: string): string =>
  ['---', 'pm-task: true', `id: ${id}`, `projectId: ${projectId}`, `title: ${title}`, 'status: todo', '---', ''].join(
    '\n'
  )

interface FakeLeaf {
  state: Record<string, unknown>
  getViewState: () => { type: string; state: Record<string, unknown> }
  setViewState: (viewState: { type: string; state: Record<string, unknown> }) => void
}

function fakeLeaf(state: Record<string, unknown>): FakeLeaf {
  const leaf: FakeLeaf = {
    state,
    getViewState: () => ({ type: 'pm-project', state: leaf.state }),
    setViewState: (viewState) => {
      leaf.state = viewState.state
    }
  }
  return leaf
}

async function legacyVault(leaves: FakeLeaf[]): Promise<{ plugin: PMPlugin; app: App; settings: PMSettings }> {
  const { app, vault } = makeFakeApp({ liveMetadataCache: true })
  const typed = app as unknown as App
  await vault.create('Projects/Roadmap.md', projectNote('p1', 'Roadmap'))
  await vault.create('Projects/Roadmap_tasks/design.md', taskNote('t1', 'Design', 'p1'))
  await vault.create('Projects/Roadmap_tasks/Archive/old.md', taskNote('t2', 'Old', 'p1'))

  const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
  const index = new VaultIndex(typed, () => settings)
  index.build()
  const store = new ProjectStore(typed, () => settings, index)

  const plugin = {
    app: {
      ...app,
      workspace: {
        iterateAllLeaves: (visit: (leaf: FakeLeaf) => void) => {
          for (const leaf of leaves) visit(leaf)
        }
      }
    },
    index,
    store,
    settings,
    saveSettings: async () => {}
  } as unknown as PMPlugin

  return { plugin, app: typed, settings }
}

describe('migrateProjectLayout', () => {
  it('moves a project and its tasks into a folder of its own', async () => {
    const { plugin, app } = await legacyVault([])

    await migrateProjectLayout(plugin)

    expect(app.vault.getAbstractFileByPath('Projects/Roadmap/Roadmap.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Roadmap/_tasks/design.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Roadmap/_tasks/Archive/old.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Roadmap_tasks')).toBeNull()
  })

  it('carries the filters, saved views and collapsed state over to the new path', async () => {
    const { plugin, settings } = await legacyVault([])
    settings.projectFilters['project:Projects/Roadmap.md'] = {
      filter: makeDefaultFilter(),
      activeSavedViewId: null,
      sort: makeDefaultSort(),
      group: makeDefaultGroup(),
      fields: {},
      ganttGranularity: 'week',
      nonWorkingDays: {}
    }
    settings.scopeViews['subtree:Projects/Roadmap.md'] = []
    settings.collapsedTasks['Projects/Roadmap.md'] = ['t1']
    settings.collapsedProjects.push('Projects/Roadmap.md')

    await migrateProjectLayout(plugin)

    expect(settings.projectFilters['project:Projects/Roadmap/Roadmap.md']).toBeDefined()
    expect(settings.projectFilters['project:Projects/Roadmap.md']).toBeUndefined()
    expect(settings.scopeViews['subtree:Projects/Roadmap/Roadmap.md']).toBeDefined()
    expect(settings.collapsedTasks['Projects/Roadmap/Roadmap.md']).toEqual(['t1'])
    expect(settings.collapsedProjects).toEqual(['Projects/Roadmap/Roadmap.md'])
  })

  it('retargets the tabs the workspace restored before it ran', async () => {
    const scoped = fakeLeaf({ scope: { kind: 'subtree', path: 'Projects/Roadmap.md' } })
    const overview = fakeLeaf({ filePath: 'Projects/Roadmap.md' })
    const task = fakeLeaf({ filePath: 'Projects/Roadmap_tasks/design.md', projectPath: 'Projects/Roadmap.md' })
    const unrelated = fakeLeaf({ filePath: 'Notes/idea.md' })
    const { plugin } = await legacyVault([scoped, overview, task, unrelated])

    await migrateProjectLayout(plugin)

    expect(scoped.state.scope).toEqual({ kind: 'subtree', path: 'Projects/Roadmap/Roadmap.md' })
    expect(overview.state.filePath).toBe('Projects/Roadmap/Roadmap.md')
    expect(task.state.filePath).toBe('Projects/Roadmap/_tasks/design.md')
    expect(task.state.projectPath).toBe('Projects/Roadmap/Roadmap.md')
    expect(unrelated.state.filePath).toBe('Notes/idea.md')
  })

  it('repoints a sub-project at its parent new path', async () => {
    const { plugin, app } = await legacyVault([])
    await app.vault.create(
      'Projects/Q3.md',
      [
        '---',
        'pm-project: true',
        'id: p2',
        'title: Q3',
        'parent: "[[Projects/Roadmap]]"',
        'taskIds: []',
        '---',
        ''
      ].join('\n')
    )
    plugin.index.build()

    await migrateProjectLayout(plugin)

    const child = expectDefined(await plugin.store.loadProjectByPath('Projects/Q3/Q3.md'))
    expect(child.parentPath).toBe('Projects/Roadmap/Roadmap.md')
  })

  it('does nothing on a second run', async () => {
    const { plugin, app } = await legacyVault([])
    await migrateProjectLayout(plugin)
    const before = app.vault.getAbstractFileByPath('Projects/Roadmap/Roadmap.md')

    await migrateProjectLayout(plugin)

    expect(app.vault.getAbstractFileByPath('Projects/Roadmap/Roadmap.md')).toBe(before)
    expect(app.vault.getAbstractFileByPath('Projects/Roadmap/Roadmap')).toBeNull()
  })
})

const idRefProject = (): string =>
  ['---', 'pm-project: true', 'id: p1', 'title: Roadmap', 'taskIds:', '  - t1', '---', ''].join('\n')

const idRefTask = (id: string, title: string, extra: string[]): string =>
  ['---', 'pm-task: true', `id: ${id}`, 'projectId: p1', `title: ${title}`, 'status: todo', ...extra, '---', ''].join(
    '\n'
  )

async function idRefVault(): Promise<{ plugin: PMPlugin; app: App }> {
  const { app, vault } = makeFakeApp({ liveMetadataCache: true })
  const typed = app as unknown as App
  await vault.create('Projects/Roadmap/Roadmap.md', idRefProject())
  await vault.create('Projects/Roadmap/_tasks/parent.md', idRefTask('t1', 'Parent', ['subtaskIds:', '  - t2']))
  await vault.create('Projects/Roadmap/_tasks/child.md', idRefTask('t2', 'Child', ['parentId: t1']))

  const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
  const index = new VaultIndex(typed, () => settings)
  index.build()
  const store = new ProjectStore(typed, () => settings, index)
  const plugin = { app, index, store, settings, saveSettings: async () => {} } as unknown as PMPlugin
  return { plugin, app: typed }
}

const contentAt = async (app: App, path: string): Promise<string> => {
  const file = app.vault.getAbstractFileByPath(path)
  if (!(file instanceof TFile)) throw new Error(`no file at ${path}`)
  return app.vault.cachedRead(file)
}

describe('migrateTaskRefs', () => {
  it('names a parent and its subtasks by link in notes that still hold ids', async () => {
    const { plugin, app } = await idRefVault()

    await migrateTaskRefs(plugin)

    expect(await contentAt(app, 'Projects/Roadmap/_tasks/parent.md')).toContain('subtaskIds: ["[[child|Child]]"]')
    expect(await contentAt(app, 'Projects/Roadmap/_tasks/child.md')).toContain('parentId: "[[parent|Parent]]"')
    expect(await contentAt(app, 'Projects/Roadmap/Roadmap.md')).toContain('taskIds: ["[[parent|Parent]]"]')
  })

  it('keeps the tree it rewrote', async () => {
    const { plugin, app } = await idRefVault()

    await migrateTaskRefs(plugin)

    const store = new ProjectStore(app, () => structuredClone(DEFAULT_SETTINGS))
    const reloaded = expectDefined(await store.loadProjectByPath('Projects/Roadmap/Roadmap.md'))
    expect(reloaded.tasks.map((t) => t.id)).toEqual(['t1'])
    expect(reloaded.tasks[0].subtasks.map((t) => t.id)).toEqual(['t2'])
  })

  it('rewrites nothing on a second run', async () => {
    const { plugin } = await idRefVault()
    await migrateTaskRefs(plugin)
    const rewrite = vi.spyOn(plugin.store, 'normalizeTaskRefs')

    await migrateTaskRefs(plugin)

    expect(rewrite).not.toHaveBeenCalled()
  })
})

describe('migrateTaskRefs leaves the note itself alone', () => {
  it('keeps the name and the body of a note the user renamed and wrote in', async () => {
    const { app, vault } = makeFakeApp({ liveMetadataCache: true })
    const typed = app as unknown as App
    await vault.create('Projects/Roadmap/Roadmap.md', idRefProject())
    const body = ['', 'My research notes.', '', '## Subtasks', '', 'Notes I wrote under my own heading.'].join('\n')
    await vault.create(
      'Projects/Roadmap/_tasks/my-own-name.md',
      idRefTask('t1', 'Design the thing', ['subtaskIds:', '  - t2']) + body
    )
    await vault.create('Projects/Roadmap/_tasks/child.md', idRefTask('t2', 'Child', ['parentId: t1']))

    const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
    const index = new VaultIndex(typed, () => settings)
    index.build()
    const store = new ProjectStore(typed, () => settings, index)
    const plugin = { app, index, store, settings, saveSettings: async () => {} } as unknown as PMPlugin

    await migrateTaskRefs(plugin)

    const content = await contentAt(typed, 'Projects/Roadmap/_tasks/my-own-name.md')
    expect(content).toContain('subtaskIds: ["[[child|Child]]"]')
    expect(content).toContain('Notes I wrote under my own heading.')
    expect(typed.vault.getMarkdownFiles().map((f) => f.path)).not.toContain(
      'Projects/Roadmap/_tasks/design-the-thing.md'
    )
  })
})

describe('migrateBoardCardConfig', () => {
  async function vaultWith(config: string[]): Promise<{ plugin: PMPlugin; app: App; settings: PMSettings }> {
    const { app, vault } = makeFakeApp({ liveMetadataCache: true })
    const typed = app as unknown as App
    const note = ['---', 'pm-project: true', 'id: p1', 'title: Roadmap', 'config:', ...config, '---', ''].join('\n')
    await vault.create('Projects/Roadmap/Roadmap.md', note)
    const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
    const index = new VaultIndex(typed, () => settings)
    index.build()
    const plugin = { app: typed, index, settings, saveSettings: async () => {} } as unknown as PMPlugin
    return { plugin, app: typed, settings }
  }

  const frontmatter = (app: App): Record<string, unknown> | undefined => {
    const file = app.vault.getAbstractFileByPath('Projects/Roadmap/Roadmap.md')
    return file instanceof TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined
  }

  it('moves the project overrides into its view and out of the note', async () => {
    const { plugin, app, settings } = await vaultWith([
      '  kanbanShowSubtasks: true',
      '  kanbanShowDescriptionPreview: false',
      '  autoSchedule: false'
    ])
    await migrateBoardCardConfig(plugin)
    const visible = settings.projectFilters['project:Projects/Roadmap/Roadmap.md'].fields.kanban?.visible
    expect(visible).toContain('subtasks')
    expect(visible).not.toContain('description')
    expect(frontmatter(app)?.config).toEqual({ autoSchedule: false })
  })

  it('keeps what the global setting gave a view for a key the note leaves out', async () => {
    const { plugin, app, settings } = await vaultWith(['  kanbanShowSubtasks: false'])
    settings.projectFilters['project:Projects/Roadmap/Roadmap.md'] = {
      filter: makeDefaultFilter(),
      activeSavedViewId: null,
      sort: makeDefaultSort(),
      group: makeDefaultGroup(),
      fields: { kanban: { visible: ['priority', 'description', 'subtasks'] } },
      ganttGranularity: 'week',
      nonWorkingDays: {}
    }
    await migrateBoardCardConfig(plugin)
    const visible = settings.projectFilters['project:Projects/Roadmap/Roadmap.md'].fields.kanban?.visible
    expect(visible).toContain('description')
    expect(visible).not.toContain('subtasks')
    expect(frontmatter(app)?.config).toBeUndefined()
  })

  it('starts a project never opened from the global setting for a key the note leaves out', async () => {
    const { plugin, settings } = await vaultWith(['  kanbanShowSubtasks: false'])
    settings.defaultFields = { kanban: { visible: ['priority', 'description', 'subtasks'] } }
    await migrateBoardCardConfig(plugin)
    const visible = settings.projectFilters['project:Projects/Roadmap/Roadmap.md'].fields.kanban?.visible
    expect(visible).toContain('description')
    expect(visible).not.toContain('subtasks')
  })

  it('leaves a note without the old keys alone', async () => {
    const { plugin, settings } = await vaultWith(['  autoSchedule: true'])
    await migrateBoardCardConfig(plugin)
    expect(settings.projectFilters).toEqual({})
  })
})

describe('migrateProjectNesting', () => {
  function projectNoteWithParent(id: string, title: string, parentPath: string | null): string {
    const lines = ['---', 'pm-project: true', `id: ${id}`, `title: ${title}`]
    if (parentPath) lines.push(`parent: "[[${parentPath.replace(/\.md$/, '')}]]"`)
    lines.push('taskIds:', '  - t1', '---', '')
    return lines.join('\n')
  }

  const taskNoteWithProject = (id: string, title: string, projectId: string): string =>
    ['---', 'pm-task: true', `id: ${id}`, `projectId: ${projectId}`, `title: ${title}`, 'status: todo', '---', ''].join(
      '\n'
    )

  async function nestedVault(): Promise<{ plugin: PMPlugin; app: App; settings: PMSettings }> {
    const { app, vault } = makeFakeApp({ liveMetadataCache: true })
    const typed = app as unknown as App
    // Parent already in its own folder, Child at root (should be under parent)
    await vault.create('Projects/Parent/Parent.md', projectNoteWithParent('p1', 'Parent', null))
    await vault.create('Projects/Parent/_tasks/parent-task.md', taskNoteWithProject('t1', 'Parent Task', 'p1'))
    await vault.create('Projects/Child.md', projectNoteWithParent('p2', 'Child', 'Projects/Parent/Parent.md'))
    await vault.create('Projects/Child_tasks/child-task.md', taskNoteWithProject('t2', 'Child Task', 'p2'))

    const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
    const index = new VaultIndex(typed, () => settings)
    index.build()
    const store = new ProjectStore(typed, () => settings, index)

    const plugin = {
      app: {
        ...typed,
        workspace: {
          iterateAllLeaves: (visit: (leaf: unknown) => void) => {}
        }
      },
      index,
      store,
      settings,
      saveSettings: async () => {}
    } as unknown as PMPlugin

    return { plugin, app: typed, settings }
  }

  async function threeLevelVault(): Promise<{ plugin: PMPlugin; app: App; settings: PMSettings }> {
    const { app, vault } = makeFakeApp({ liveMetadataCache: true })
    const typed = app as unknown as App
    // Grandparent -> Parent -> Child (all in folder layout except Child at root)
    await vault.create('Projects/Grandparent/Grandparent.md', projectNoteWithParent('p1', 'Grandparent', null))
    await vault.create('Projects/Grandparent/_tasks/gp-task.md', taskNoteWithProject('t1', 'GP Task', 'p1'))
    await vault.create(
      'Projects/Parent.md',
      projectNoteWithParent('p2', 'Parent', 'Projects/Grandparent/Grandparent.md')
    )
    await vault.create('Projects/Parent_tasks/p-task.md', taskNoteWithProject('t2', 'P Task', 'p2'))
    // Parent is at Projects/Parent.md (flat), so Child's parent link should point there
    await vault.create('Projects/Child.md', projectNoteWithParent('p3', 'Child', 'Projects/Parent.md'))
    await vault.create('Projects/Child_tasks/c-task.md', taskNoteWithProject('t3', 'C Task', 'p3'))

    const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
    const index = new VaultIndex(typed, () => settings)
    index.build()
    const store = new ProjectStore(typed, () => settings, index)

    const plugin = {
      app: {
        ...typed,
        workspace: {
          iterateAllLeaves: (visit: (leaf: unknown) => void) => {}
        }
      },
      index,
      store,
      settings,
      saveSettings: async () => {}
    } as unknown as PMPlugin

    return { plugin, app: typed, settings }
  }

  it('moves a child project at root under its parent folder', async () => {
    const { plugin, app } = await nestedVault()

    await migrateProjectNesting(plugin)

    // Child moved under Parent
    expect(app.vault.getAbstractFileByPath('Projects/Parent/Child/Child.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Child.md')).toBeNull()
    expect(app.vault.getAbstractFileByPath('Projects/Parent/Child/_tasks/child-task.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Child_tasks')).toBeNull()

    // Child's parent link updated
    const child = await plugin.store.loadProjectByPath('Projects/Parent/Child/Child.md')
    expect(child?.parentPath).toBe('Projects/Parent/Parent.md')
  })

  it('does nothing when child is already correctly nested', async () => {
    const { app, vault } = makeFakeApp({ liveMetadataCache: true })
    const typed = app as unknown as App
    // Already correctly nested
    await vault.create('Projects/Parent/Parent.md', projectNoteWithParent('p1', 'Parent', null))
    await vault.create('Projects/Parent/_tasks/parent-task.md', taskNoteWithProject('t1', 'Parent Task', 'p1'))
    await vault.create(
      'Projects/Parent/Child/Child.md',
      projectNoteWithParent('p2', 'Child', 'Projects/Parent/Parent.md')
    )
    await vault.create('Projects/Parent/Child/_tasks/child-task.md', taskNoteWithProject('t2', 'Child Task', 'p2'))

    const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
    const index = new VaultIndex(typed, () => settings)
    index.build()
    const store = new ProjectStore(typed, () => settings, index)

    const plugin = {
      app: typed,
      index,
      store,
      settings,
      saveSettings: async () => {}
    } as unknown as PMPlugin

    await migrateProjectNesting(plugin)

    // Nothing moved
    expect(app.vault.getAbstractFileByPath('Projects/Parent/Child/Child.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Child.md')).toBeNull()
  })

  it('handles three-level nesting: grandparent -> parent -> child', async () => {
    const { plugin, app } = await threeLevelVault()

    await migrateProjectNesting(plugin)

    // All moved under grandparent
    expect(app.vault.getAbstractFileByPath('Projects/Grandparent/Parent/Parent.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Grandparent/Parent/Child/Child.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Parent.md')).toBeNull()
    expect(app.vault.getAbstractFileByPath('Projects/Child.md')).toBeNull()

    // Links updated
    const parent = await plugin.store.loadProjectByPath('Projects/Grandparent/Parent/Parent.md')
    expect(parent?.parentPath).toBe('Projects/Grandparent/Grandparent.md')

    const child = await plugin.store.loadProjectByPath('Projects/Grandparent/Parent/Child/Child.md')
    expect(child?.parentPath).toBe('Projects/Grandparent/Parent/Parent.md')
  })

  it('skips project with broken parent link', async () => {
    const { app, vault } = makeFakeApp({ liveMetadataCache: true })
    const typed = app as unknown as App
    // Child points to non-existent parent
    await vault.create('Projects/Parent.md', projectNoteWithParent('p1', 'Parent', null))
    await vault.create('Projects/Parent_tasks/parent-task.md', taskNoteWithProject('t1', 'Parent Task', 'p1'))
    await vault.create('Projects/Child.md', projectNoteWithParent('p2', 'Child', 'Projects/NonExistent.md'))
    await vault.create('Projects/Child_tasks/child-task.md', taskNoteWithProject('t2', 'Child Task', 'p2'))

    const settings: PMSettings = structuredClone(DEFAULT_SETTINGS)
    const index = new VaultIndex(typed, () => settings)
    index.build()
    const store = new ProjectStore(typed, () => settings, index)

    const plugin = {
      app: typed,
      index,
      store,
      settings,
      saveSettings: async () => {}
    } as unknown as PMPlugin

    await migrateProjectNesting(plugin)

    // Child not moved (broken parent link)
    expect(app.vault.getAbstractFileByPath('Projects/Child.md')).toBeInstanceOf(TFile)
    expect(app.vault.getAbstractFileByPath('Projects/Parent/Child')).toBeNull()
  })

  it('is idempotent: second run moves nothing', async () => {
    const { plugin, app } = await nestedVault()

    await migrateProjectNesting(plugin)
    const childPath1 = 'Projects/Parent/Child/Child.md'
    const childFile1 = app.vault.getAbstractFileByPath(childPath1)

    await migrateProjectNesting(plugin)
    const childFile2 = app.vault.getAbstractFileByPath(childPath1)

    expect(childFile2).toBe(childFile1)
  })

  it('remaps project filters and scope views using the correct old path (from)', async () => {
    const { plugin, settings } = await nestedVault()
    // Add a filter for the OLD child path (Projects/Child.md)
    const oldChildPath = 'Projects/Child.md'
    settings.projectFilters[`project:${oldChildPath}`] = {
      filter: makeDefaultFilter(),
      activeSavedViewId: null,
      sort: makeDefaultSort(),
      group: makeDefaultGroup(),
      fields: {},
      ganttGranularity: 'week',
      nonWorkingDays: {}
    }
    settings.scopeViews[`subtree:${oldChildPath}`] = [
      {
        id: 'v1',
        name: 'Test',
        filter: makeDefaultFilter(),
        sort: makeDefaultSort()
      }
    ]

    await migrateProjectNesting(plugin)

    // After migration, the filter should be at the NEW path
    const newChildPath = 'Projects/Parent/Child/Child.md'
    expect(settings.projectFilters[`project:${newChildPath}`]).toBeDefined()
    expect(settings.projectFilters[`project:${oldChildPath}`]).toBeUndefined()
    expect(settings.scopeViews[`subtree:${newChildPath}`]).toBeDefined()
    expect(settings.scopeViews[`subtree:${oldChildPath}`]).toBeUndefined()
  })
})
