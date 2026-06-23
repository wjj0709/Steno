<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NIcon, NScrollbar, useMessage } from 'naive-ui';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { useAppEvents } from '@/composables/useAppEvents';
import { useDb } from '@/composables/useDb';
import { useClipboardStore } from '@/stores/clipboard';
import type { ClipboardEntry } from '@/types/steno';

const clipboard = useClipboardStore();
const db = useDb();
const events = useAppEvents();
const message = useMessage();

const isPinned = ref(false);
const dragUntil = ref(0);

const clipboardEntries = computed(() => clipboard.entries.slice(0, 30));

let unlistenToggle: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;

async function persistLastPosition() {
  if (!isTauri()) return;
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    await db.setSetting('clipboardPanelLastPos', `${pos.x},${pos.y}`);
  } catch {
    // ignore
  }
}

onMounted(async () => {
  await clipboard.load();
  await clipboard.startEventListeners();
  unlistenToggle = await events.listenClipboardPanelToggle(visible => {
    if (!visible) {
      void persistLastPosition();
    }
  });
  try {
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false);
    unlistenFocus = await win.onFocusChanged(({ payload }) => {
      if (payload) return;
      if (isPinned.value) return;
      if (Date.now() < dragUntil.value) return;
      void closePanel();
    });
  } catch {
    // non-Tauri env
  }
});

onBeforeUnmount(() => {
  unlistenToggle?.();
  unlistenToggle = null;
  unlistenFocus?.();
  unlistenFocus = null;
  clipboard.stopEventListeners();
  void persistLastPosition();
});

async function closePanel() {
  try {
    await db.hideClipboardPanel();
  } catch (e) {
    message.error(`关闭失败：${String(e)}`);
  }
}

async function togglePinned() {
  const next = !isPinned.value;
  try {
    await getCurrentWindow().setAlwaysOnTop(next);
    isPinned.value = next;
  } catch (e) {
    message.error(`置顶失败：${String(e)}`);
  }
}

async function onHeaderPointerdown(e: PointerEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest('button, input')) return;
  e.preventDefault();
  dragUntil.value = Date.now() + 500;
  try {
    await getCurrentWindow().startDragging();
  } catch {
    // ignore
  }
}

function clipboardTypeLabel(entry: ClipboardEntry) {
  switch (entry.contentType) {
    case 'url':
      return '链接';
    case 'code':
      return '代码';
    case 'image':
      return '图片';
    case 'file':
      return '文件';
    case 'rich_text':
      return '富文本';
    case 'text':
      return '文本';
  }
}

function clipboardPreview(entry: ClipboardEntry) {
  if (entry.contentType === 'image') {
    return entry.preview || '图片';
  }
  return entry.content || entry.preview;
}

async function pasteClipboardEntry(entry: ClipboardEntry) {
  try {
    if (!isPinned.value) {
      await db.hideClipboardPanel();
    }
    await clipboard.pasteEntry(entry.id);
  } catch (e) {
    message.error(`粘贴失败：${String(e)}`);
  }
}
</script>

<template>
  <div class="clipboard-panel-root">
    <header class="clipboard-panel-header" @pointerdown="onHeaderPointerdown">
      <div class="clipboard-panel-title">
        <NIcon size="18">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5a2 2 0 0 0-2 2v14h2V5h14V3zm-3 4H9a2 2 0 0 0-2 2v12h9a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
          </svg>
        </NIcon>
        <span class="clipboard-panel-label">粘贴板</span>
        <span class="clipboard-panel-count">{{ clipboardEntries.length }} 条</span>
      </div>

      <div class="clipboard-panel-actions">
        <button
          type="button"
          class="clipboard-panel-icon-button"
          :class="{ 'clipboard-panel-icon-button--active': isPinned }"
          :title="isPinned ? '取消置顶' : '置顶浮窗'"
          @click="togglePinned"
        >
          <NIcon size="15">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 3 21 10l-3 1-4 4 1 4-2 2-5-5-4 4-1-1 4-4-5-5 2-2 4 1 4-4 1-3z" />
            </svg>
          </NIcon>
        </button>
        <button
          type="button"
          class="clipboard-panel-icon-button"
          title="关闭浮窗"
          @click="closePanel"
        >
          <NIcon size="16">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </NIcon>
        </button>
      </div>
    </header>

    <div class="clipboard-panel-body">
      <NScrollbar v-if="clipboardEntries.length > 0" class="clipboard-panel-scroll">
        <ul class="clipboard-panel-list">
          <li v-for="entry in clipboardEntries" :key="entry.id" class="clipboard-panel-item">
            <span class="clipboard-panel-type">{{ clipboardTypeLabel(entry) }}</span>
            <button
              type="button"
              class="clipboard-panel-content"
              :class="{ 'clipboard-panel-content--image': entry.contentType === 'image' }"
              :title="clipboardPreview(entry)"
              @dblclick="pasteClipboardEntry(entry)"
            >
              <img
                v-if="entry.contentType === 'image'"
                class="clipboard-panel-thumb"
                :src="entry.content"
                alt="剪贴板图片预览"
              />
              <span v-else>{{ clipboardPreview(entry) }}</span>
            </button>
          </li>
        </ul>
      </NScrollbar>

      <div v-else class="clipboard-panel-empty">
        <div class="empty-check">
          <NIcon size="30">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5a2 2 0 0 0-2 2v14h2V5h14V3zm-3 4H9a2 2 0 0 0-2 2v12h9a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
            </svg>
          </NIcon>
        </div>
        <p class="empty-title">暂无粘贴板记录</p>
        <p class="empty-subtitle">复制内容后会显示在这里</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.clipboard-panel-root {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: rgba(20, 20, 24, 0.92);
  color: rgba(251, 250, 248, 0.92);
  border-radius: 18px;
  background-clip: padding-box;
  clip-path: inset(0 round 18px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  overflow: hidden;
  font-family: inherit;
  isolation: isolate;
}

.clipboard-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  cursor: default;
}

.clipboard-panel-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: rgba(251, 250, 248, 0.92);
}

.clipboard-panel-label {
  font-size: 14px;
  font-weight: 600;
}

.clipboard-panel-count {
  font-size: 11px;
  color: rgba(251, 250, 248, 0.5);
}

.clipboard-panel-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.clipboard-panel-icon-button {
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  color: rgba(251, 250, 248, 0.6);
  cursor: pointer;
  border-radius: 6px;
  display: inline-grid;
  place-items: center;
  transition: background 120ms, color 120ms;
}

.clipboard-panel-icon-button:hover,
.clipboard-panel-icon-button--active {
  background: rgba(251, 250, 248, 0.08);
  color: rgba(251, 250, 248, 0.95);
}

.clipboard-panel-icon-button--active {
  background: rgba(232, 173, 122, 0.18);
  color: rgba(232, 173, 122, 1);
}

.clipboard-panel-body {
  flex: 1;
  min-height: 0;
  padding: 0 6px 12px;
}

.clipboard-panel-scroll {
  height: 100%;
}

.clipboard-panel-list {
  list-style: none;
  margin: 0;
  padding: 0 8px;
  display: grid;
  gap: 6px;
}

.clipboard-panel-item {
  min-width: 0;
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(251, 250, 248, 0.04);
}

.clipboard-panel-type {
  color: rgba(232, 173, 122, 0.92);
  font-size: 11px;
  font-weight: 650;
}

.clipboard-panel-content {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: rgba(251, 250, 248, 0.86);
  cursor: text;
  font: 12.5px/1.45 ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clipboard-panel-content:focus-visible {
  outline: 2px solid rgba(232, 173, 122, 0.5);
  outline-offset: 3px;
}

.clipboard-panel-content--image {
  cursor: pointer;
  white-space: normal;
}

.clipboard-panel-thumb {
  display: block;
  max-width: 100%;
  max-height: 44px;
  object-fit: contain;
  border-radius: 4px;
  background: rgba(251, 250, 248, 0.06);
}

.clipboard-panel-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: rgba(251, 250, 248, 0.5);
}

.empty-check {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(251, 250, 248, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
  color: rgba(251, 250, 248, 0.55);
}

.empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: rgba(251, 250, 248, 0.85);
}

.empty-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgba(251, 250, 248, 0.5);
}
</style>
