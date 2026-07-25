<!--
  ShellApp · P0 脚手架占位页
  只证明链路通:令牌生效 + 组件可渲 + preload 桥可探;P1 按 desktop.html W1 重写。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { KButton, KBadge, KDot, KToggle, KToaster, useToast } from '../components'

const toast = useToast()
const bridged = ref(false)
const theme = ref('')
const sw = ref(true)

onMounted(() => {
  // preload 桥在纯浏览器/lab 环境不存在,必须软探
  bridged.value = typeof window.BocomHermes !== 'undefined'
  try { theme.value = window.BocomHermes?.getTheme?.() || '' } catch (e) { /* 桥未就绪不致命 */ }
})
</script>

<template>
  <div class="boot">
    <div class="card">
      <div class="hd">
        <KDot color="blue" />
        <span class="t">BocomHermes · Vue 脚手架已通</span>
        <KBadge :type="bridged ? 'green' : 'orange'">{{ bridged ? '桥已接' : '桥缺席' }}</KBadge>
      </div>
      <p class="d">
        P0 占位页:设计令牌 + 组件库 + 单文件内联构建链路验证。
        preload 桥状态:{{ bridged ? `已注入(主题 ${theme || '?'})` : '未注入(纯浏览器预览)' }}。
        主窗口 W1 实现见 P1。
      </p>
      <div class="row">
        <KButton @click="toast.success('脚手架链路正常')">试试 Toast</KButton>
        <KButton variant="secondary" @click="toast.info('组件库 14 件已就位')">组件清单</KButton>
        <KToggle v-model="sw" label="演示开关" />
      </div>
    </div>
    <KToaster />
  </div>
</template>

<style scoped>
.boot { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg-ground); }
.card {
  width: 520px; background: var(--bg-primary); border: 0.5px solid var(--sep);
  border-radius: var(--r-xl); padding: var(--s6); display: flex; flex-direction: column; gap: var(--s4);
  box-shadow: var(--shadow-small);
}
.hd { display: flex; align-items: center; gap: var(--s2); }
.hd .t { font: var(--t2-em); flex: 1; }
.d { font: var(--b2); color: var(--label-2); line-height: 1.8; }
.row { display: flex; gap: var(--s3); align-items: center; }
</style>
