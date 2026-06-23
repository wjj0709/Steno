/**
 * @file 前端视图 - Clipboard Quick Panel 测试
 *
 * 覆盖粘贴板浮窗的列表渲染、空态与双击粘贴行为。
 */

// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClipboardEntry } from '@/types/steno';
import ClipboardQuickPanel from './ClipboardQuickPanel.vue';

// ---- mocks ----

const listClipboardEntries = vi.fn<() => Promise<ClipboardEntry[]>>();
const pasteClipboardEntry = vi.fn<(id: string) => Promise<void>>();
const copyClipboardEntry = vi.fn<(id: string) => Promise<void>>();
const hideClipboardPanel = vi.fn<() => Promise<void>>();
const setSetting = vi.fn<(key: string, value: string) => Promise<void>>();
const setAlwaysOnTop = vi.fn<(alwaysOnTop: boolean) => Promise<void>>();
let focusChangedHandler: ((event: { payload: boolean }) => void) | null = null;

vi.mock('@/composables/useDb', () => ({
  useDb: () => ({
    listClipboardEntries,
    pasteClipboardEntry,
    copyClipboardEntry,
    hideClipboardPanel,
    setSetting
  })
}));

vi.mock('@/composables/useAppEvents', () => ({
  useAppEvents: () => ({
    listenClipboardPanelToggle: async () => () => {}
  })
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 0, y: 0 }),
    setAlwaysOnTop,
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      focusChangedHandler = handler;
      return () => {
        focusChangedHandler = null;
      };
    }
  })
}));

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui');
  return {
    ...actual,
    useMessage: () => ({
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn()
    })
  };
});

// ---- fixtures ----

function nowIso(): string {
  return new Date().toISOString();
}

function makeClipboardEntry(overrides: Partial<ClipboardEntry> = {}): ClipboardEntry {
  return {
    id: 'clip-1',
    contentType: 'text',
    content: '剪贴板内容',
    htmlContent: null,
    preview: '剪贴板内容',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    sizeBytes: 15,
    pinnedAt: null,
    ...overrides
  };
}

describe('ClipboardQuickPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listClipboardEntries.mockReset().mockResolvedValue([]);
    pasteClipboardEntry.mockReset().mockResolvedValue();
    copyClipboardEntry.mockReset().mockResolvedValue();
    hideClipboardPanel.mockReset().mockResolvedValue();
    setSetting.mockReset().mockResolvedValue();
    setAlwaysOnTop.mockReset().mockResolvedValue();
    focusChangedHandler = null;
  });

  it('renders empty state when no clipboard entries', async () => {
    const wrapper = mount(ClipboardQuickPanel);
    await flushPromises();

    expect(wrapper.text()).toContain('暂无粘贴板记录');
  });

  it('lists clipboard entries and pastes one on double click', async () => {
    listClipboardEntries.mockResolvedValue([makeClipboardEntry({ id: 'clip-a', content: '从浮窗粘贴' })]);

    const wrapper = mount(ClipboardQuickPanel);
    await flushPromises();

    expect(wrapper.text()).toContain('从浮窗粘贴');

    await wrapper.get('.clipboard-panel-content').trigger('dblclick');
    await flushPromises();

    expect(pasteClipboardEntry).toHaveBeenCalledWith('clip-a');
  });

  it('closes the panel on blur while unpinned', async () => {
    const wrapper = mount(ClipboardQuickPanel);
    await flushPromises();

    expect(setAlwaysOnTop).toHaveBeenCalledWith(false);

    focusChangedHandler?.({ payload: false });
    await flushPromises();

    expect(hideClipboardPanel).toHaveBeenCalled();
    wrapper.unmount();
  });
});
