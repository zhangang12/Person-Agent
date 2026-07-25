<!--
  KDialog · 对话框(alertdialog)
  契约(interactions.html 03):
  - 恒宽 360px、radius.xl、无关闭钮;title + desc + 双钮(右对齐)
  - role=alertdialog、aria-modal;mask = --mask,点 mask = 点安全动作(取消)
  - 破坏性操作初始焦点落「取消」;Esc = 取消
  - 进出 180ms ez-out:内容 scale(.96→1),mask 同步 fade;层叠唯一遮罩
-->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import KButton from './KButton.vue'

interface Props {
  open: boolean
  title: string
  desc?: string
  confirmText?: string
  cancelText?: string
  /** 破坏性:确认钮 danger 且初始焦点落取消 */
  destructive?: boolean
  /** 确认中(确认钮 loading,面板不自动关) */
  confirming?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  desc: '', confirmText: '确定', cancelText: '取消', destructive: false, confirming: false,
})
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const cancelBtn = ref<InstanceType<typeof KButton> | null>(null)

function close(kind: 'confirm' | 'cancel') {
  if (kind === 'confirm') emit('confirm')
  else { emit('cancel'); emit('update:open', false) }
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') { ev.stopPropagation(); close('cancel') }
}

watch(() => props.open, async (v) => {
  if (!v) return
  // 初始焦点:破坏性落「取消」;常规也落取消(安全动作优先)
  await nextTick()
  const el = (cancelBtn.value as any)?.$el as HTMLElement | undefined
  el?.focus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="k-dlg">
      <div v-if="open" class="k-dlg-mask" @click="close('cancel')" @keydown="onKeydown">
        <div
          class="k-dlg"
          role="alertdialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
          @click.stop
        >
          <div class="t">{{ title }}</div>
          <div v-if="desc || $slots.default" class="d"><slot>{{ desc }}</slot></div>
          <div class="ft">
            <KButton ref="cancelBtn" variant="secondary" @click="close('cancel')">{{ cancelText }}</KButton>
            <KButton variant="primary" :danger="destructive" :loading="confirming" @click="close('confirm')">{{ confirmText }}</KButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.k-dlg-mask {
  position: fixed; inset: 0; z-index: var(--z-dialog); background: var(--mask);
  display: flex; align-items: center; justify-content: center;
}
.k-dlg {
  width: 360px; background: var(--bg-secondary); border-radius: var(--r-xl);
  padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); outline: none;
}
.k-dlg .t { font: var(--t2-em); }
.k-dlg .d { font: var(--b2); line-height: 20px; color: var(--label-1); }
.k-dlg .ft { display: flex; gap: var(--s2); justify-content: flex-end; }

/* 180ms ez-out:内容 scale(.96→1),mask fade,时序一致 */
.k-dlg-enter-active, .k-dlg-leave-active { transition: opacity var(--dialog-dur) var(--ez-out); }
.k-dlg-enter-active .k-dlg, .k-dlg-leave-active .k-dlg { transition: transform var(--dialog-dur) var(--ez-out), opacity var(--dialog-dur) var(--ez-out); }
.k-dlg-enter-from, .k-dlg-leave-to { opacity: 0; }
.k-dlg-enter-from .k-dlg, .k-dlg-leave-to .k-dlg { transform: scale(0.96); opacity: 0; }
</style>
