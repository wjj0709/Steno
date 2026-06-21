/**
 * @file 待办事项 Store — 主窗口与待办浮窗共享的缓存层
 *
 * SQLite 是单一真实来源，本 store 只缓存全量待办并派生分类视图。
 * 写操作走 `useDb()`，本地乐观更新后由 `steno:todo-changed` 事件兜底
 * 把权威数据合并回来（见 `applyRemoteChange`）。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { useAppEvents } from '@/composables/useAppEvents';
import { useDb } from '@/composables/useDb';
import type {
  CreateTodoRequest,
  Todo,
  TodoActivityPoint,
  TodoCategory,
  TodoChangePayload,
  TodoDailyTrendRequest,
  TodoStatsRange,
  TodoTrendPoint,
  TodoStatus,
  UpdateTodoRequest
} from '@/types/steno';

/**
 * 待办事项 Pinia store — 主窗口 TodoView 与浮窗 TodoQuickPanel 共享同一实例。
 *
 * ## 数据流
 * 1. `load()` 拉全量待办；UI 切到待办视图时调用。
 * 2. 写操作（create/update/complete/delete）走 IPC，并在本地乐观更新；
 *    后端写入后会通过 `steno:todo-changed` 事件广播，`applyRemoteChange` 再
 *    把权威 payload 合并进缓存，覆盖乐观更新中的临时态。
 * 3. 跨窗口同步由 `startEventListeners()` 注册一次性监听器。
 *
 * ## 分类计数（categoryCounts）
 * 与设计稿一致：今天 / 计划中 / 进行中 / 已暂停 / 已完成 / 全部 / 收件箱。
 * 全部用 getter 派生，写入操作无需手动维护计数。
 */
export const useTodosStore = defineStore('todos', () => {
  // IPC 封装层；所有 action 通过它调 invoke。
  const db = useDb();
  // 跨窗口事件工具集；用于监听 steno:todo-changed 实现多窗口同步。
  const events = useAppEvents();

  /** 全量待办缓存（load 拉取，写操作就地在此 upsert/remove）。 */
  const entries = ref<Todo[]>([]);
  /** 是否正在拉取列表，UI 据此显示骨架屏。 */
  const loading = ref(false);
  /** 最近一次操作的错误消息；非 null 时 UI 可提示。 */
  const error = ref<string | null>(null);
  /** 当前选中的分类标签（今天/计划中/进行中/...），驱动 visibleEntries。 */
  const selectedCategory = ref<TodoCategory>('today');

  /** 事件监听是否已启动（幂等保护，避免重复 listen 造成多次回调）。 */
  const listenersStarted = ref(false);
  /** 已注册的 unlisten 函数列表，stopEventListeners 时逐个调用清理。 */
  const unlisteners: Array<() => void> = [];

  // ---------- getters ----------

  /** 判断给定 ISO 时间戳是否落在"今天本地日"。 */
  function isToday(iso: string | null): boolean {
    if (!iso) return false;
    // 解析 ISO 字符串；非法日期（NaN）直接判否。
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return false;
    // 与"现在"的本地年月日比较（不用时间戳，避免时区漂移）。
    const now = new Date();
    return (
      date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
    );
  }

  /**
   * 今日维度 — 与后端 `list_today_todos` 的语义对齐：
   * - 未完成 + (dueDate 在今天 OR (dueDate 为空 且 createdAt 在今天))
   */
  const todayEntries = computed<Todo[]>(() =>
    entries.value.filter(item => {
      if (item.status === 'done') return false;
      if (item.dueDate) return isToday(item.dueDate);
      return isToday(item.createdAt);
    })
  );

  /** 计划中 = 未完成且有 dueDate 的项（不论日期是否到期）。 */
  const plannedEntries = computed<Todo[]>(() =>
    entries.value.filter(item => item.status !== 'done' && Boolean(item.dueDate))
  );

  /** 进行中 = status='doing' 的项。 */
  const doingEntries = computed<Todo[]>(() => entries.value.filter(item => item.status === 'doing'));

  /** 已暂停 = status='paused' 的项。 */
  const pausedEntries = computed<Todo[]>(() => entries.value.filter(item => item.status === 'paused'));

  /** 已完成 = status='done' 的项。 */
  const doneEntries = computed<Todo[]>(() => entries.value.filter(item => item.status === 'done'));

  /** 收件箱 = listId='default' 的未完成项（用户未指定清单的"默认箱"）。 */
  const inboxEntries = computed<Todo[]>(() =>
    entries.value.filter(item => item.status !== 'done' && item.listId === 'default')
  );

  /** 各分类的条目数（侧边栏徽标用），全派生自上面的 computed，写入无需手动维护。 */
  const categoryCounts = computed(() => ({
    today: todayEntries.value.length,
    planned: plannedEntries.value.length,
    doing: doingEntries.value.length,
    paused: pausedEntries.value.length,
    done: doneEntries.value.length,
    all: entries.value.length,
    inbox: inboxEntries.value.length
  }));

  /** 按 category 取对应的 computed 列表；'all' 与未知值回退到全量 entries。 */
  function byCategory(category: TodoCategory): Todo[] {
    switch (category) {
      case 'today':
        return todayEntries.value;
      case 'planned':
        return plannedEntries.value;
      case 'doing':
        return doingEntries.value;
      case 'paused':
        return pausedEntries.value;
      case 'done':
        return doneEntries.value;
      case 'inbox':
        return inboxEntries.value;
      case 'all':
      default:
        return entries.value;
    }
  }

  /** 当前分类下应展示的条目（TodoView 列表的数据源）。 */
  const visibleEntries = computed<Todo[]>(() => byCategory(selectedCategory.value));

  // ---------- helpers ----------

  function upsertLocal(todo: Todo) {
    // 查同 id 旧项：找不到就插到列表头（最新优先），找到就替换。
    const idx = entries.value.findIndex(item => item.id === todo.id);
    if (idx === -1) {
      entries.value = [todo, ...entries.value];
    } else {
      // 复制数组再替换触发响应式；直接 entries.value[idx]=todo 不会让 computed 重算。
      const next = [...entries.value];
      next[idx] = todo;
      entries.value = next;
    }
  }

  /** 从本地缓存移除指定 id（删除/逻辑删除后调用）。 */
  function removeLocal(id: string) {
    entries.value = entries.value.filter(item => item.id !== id);
  }

  // ---------- actions ----------

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      entries.value = await db.listTodos();
    } catch (e) {
      error.value = String(e);
      entries.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 拉取今日待办并合并进全量缓存（避免跨分类切换时重复拉取）。 */
  async function loadToday(includeCompleted = false): Promise<Todo[]> {
    try {
      // 后端按"今天到期 OR 今天创建且无截止"过滤，返回今日子集。
      const list = await db.getTodayTodos(includeCompleted);
      // 也合并到全量缓存，便于跨分类切换不重复拉取。
      for (const item of list) {
        upsertLocal(item);
      }
      return list;
    } catch (e) {
      error.value = String(e);
      return [];
    }
  }

  /** 新建待办并插入到本地列表头。 */
  async function createTodo(input: CreateTodoRequest): Promise<Todo> {
    const todo = await db.createTodo(input);
    upsertLocal(todo);
    return todo;
  }

  /** 部分字段更新待办并同步本地缓存。 */
  async function updateTodo(input: UpdateTodoRequest): Promise<Todo> {
    const todo = await db.updateTodo(input);
    upsertLocal(todo);
    return todo;
  }

  /** 切换状态的快捷路径（等价 updateTodo({ id, status })）。 */
  async function setStatus(id: string, status: TodoStatus): Promise<Todo> {
    return await updateTodo({ id, status });
  }

  /** 标记为已完成并同步本地。 */
  async function completeTodo(id: string): Promise<Todo> {
    const todo = await db.completeTodo(id);
    upsertLocal(todo);
    return todo;
  }

  /** 删除待办（逻辑删除）并从本地缓存移除。 */
  async function deleteTodo(id: string): Promise<void> {
    await db.deleteTodo(id);
    removeLocal(id);
  }

  /** 查询活跃度热力图数据（透传给 StatsView）。 */
  function getActivity(input: TodoStatsRange): Promise<TodoActivityPoint[]> {
    return db.getTodoActivity(input);
  }

  /** 查询每日趋势数据（透传给 StatsView）。 */
  function getDailyTrend(input: TodoDailyTrendRequest): Promise<TodoTrendPoint[]> {
    return db.getTodoDailyTrend(input);
  }

  /** 永久清除已完成和已删除任务，返回删除条数。 */
  function resetStats(): Promise<number> {
    return db.resetTodoStats();
  }

  /**
   * 处理后端 `steno:todo-changed` 事件 — 按 kind 局部更新缓存。
   *
   * 同窗口的本地写操作也会触发本事件（因为 emit 是全窗口广播），所以
   * `upsertLocal` 必须幂等。
   */
  function applyRemoteChange(payload: TodoChangePayload) {
    switch (payload.kind) {
      case 'created':
      case 'updated':
      case 'completed':
        if (payload.todo) upsertLocal(payload.todo);
        break;
      case 'deleted':
        removeLocal(payload.id);
        break;
      case 'reset':
        void load();
        break;
    }
  }

  /** 切换当前选中的分类标签（驱动 visibleEntries 重算）。 */
  function setSelectedCategory(category: TodoCategory) {
    selectedCategory.value = category;
  }

  // ---------- event listeners ----------

  async function startEventListeners() {
    if (listenersStarted.value) return;
    listenersStarted.value = true;
    try {
      // 注册监听器并保存 unlisten；App.vue onMounted 调用 startEventListeners。
      const unlisten = await events.listenTodoChanged(payload => {
        applyRemoteChange(payload);
      });
      unlisteners.push(unlisten);
    } catch (e) {
      listenersStarted.value = false;
      error.value = String(e);
    }
  }

  /** 注销所有事件监听器；App.vue onBeforeUnmount 调用，避免内存泄漏。 */
  function stopEventListeners() {
    while (unlisteners.length) {
      unlisteners.pop()?.();
    }
    listenersStarted.value = false;
  }

  return {
    entries,
    loading,
    error,
    selectedCategory,
    todayEntries,
    plannedEntries,
    doingEntries,
    pausedEntries,
    doneEntries,
    inboxEntries,
    categoryCounts,
    visibleEntries,
    byCategory,
    load,
    loadToday,
    createTodo,
    updateTodo,
    setStatus,
    completeTodo,
    deleteTodo,
    getActivity,
    getDailyTrend,
    resetStats,
    applyRemoteChange,
    setSelectedCategory,
    startEventListeners,
    stopEventListeners
  };
});
