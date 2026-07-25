<!--
  KToaster · Toast 顶中栈容器(每页面挂一次,配合 useToast 使用)
  契约:顶中;进场 350ms translateY(-8px)→0 + fade;退场 260ms 仅 fade;
  最多叠 3 条挤出(逻辑在 toast.ts)。
-->
<script setup lang="ts">
import KToastItem from './KToastItem.vue'
import { toastStack, useToast } from './toast'

const { dismiss } = useToast()
</script>

<template>
  <Teleport to="body">
    <div class="k-toaster" aria-live="polite">
      <TransitionGroup name="k-toast">
        <div v-for="t in toastStack" :key="t.id" class="k-toast-cell" :class="{ leaving: t.leaving }">
          <KToastItem
            :type="t.type" :message="t.message" :action-label="t.action?.label"
            @action="t.action?.onClick(); dismiss(t.id)"
          />
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.k-toaster {
  position: fixed; top: var(--s4); left: 50%; transform: translateX(-50%);
  z-index: var(--z-toast); display: flex; flex-direction: column; align-items: center; gap: var(--s2);
  pointer-events: none;
}
.k-toast-cell { pointer-events: auto; }
/* 进场:350ms ez-out,translateY(-8px)→0 + opacity */
.k-toast-enter-from { opacity: 0; transform: translateY(-8px); }
.k-toast-enter-active { transition: opacity var(--toast-in-dur) var(--ez-out), transform var(--toast-in-dur) var(--ez-out); }
/* 退场:260ms 仅 fade,不回弹(leaving 标记驱动,见 toast.ts) */
.k-toast-cell.leaving { transition: opacity var(--toast-out-dur) var(--ez-out); opacity: 0; }
/* 挤出时下方条目补位 */
.k-toast-move { transition: transform var(--toast-out-dur) var(--ez-out); }
</style>
