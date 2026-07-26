<script setup lang="ts">
// 成果抽屉(右侧滑出):最终结论(最近一轮终答)+ 产出文件清单(write/edit 落盘,相对路径展示)
// + 点文件 readFileText 预览(主进程路径围栏:项目目录/userData 内 ≤512KB)。
import { ref, computed } from 'vue'
import { s } from './store'
import { artRel } from './lib/tool'
import { BH } from './bridge'

const activePath = ref('')
const preview = ref('')
const previewErr = ref('')
const loading = ref(false)
const files = computed(() => s.artFiles.map((p) => ({ abs: p, rel: artRel(p, s.dir) })))

async function openFile(abs: string) {
  activePath.value = abs
  preview.value = ''; previewErr.value = ''; loading.value = true
  try {
    const r = await BH()?.readFileText?.(abs)
    if (r && r.ok) preview.value = String(r.text || '')
    else previewErr.value = (r && r.err) || '读不到文件内容'
  } catch (e: any) { previewErr.value = String((e && e.message) || e) }
  loading.value = false
}
function close() { s.artOpen = false }
</script>

<template>
  <div v-if="s.artOpen" class="artdrawer">
    <div class="ad-hd">
      <span class="ad-title">成果</span>
      <span class="ad-cnt">{{ s.artFiles.length }} 个产出文件</span>
      <span class="sp"></span>
      <button class="ad-x" @click="close">✕</button>
    </div>
    <div class="ad-body">
      <div class="ad-sec">
        <div class="ad-lb">最终结论</div>
        <div class="ad-final">{{ s.lastFinalText || '（本轮还没有最终结论）' }}</div>
      </div>
      <div class="ad-sec">
        <div class="ad-lb">产出文件</div>
        <div v-if="!files.length" class="ad-empty">还没有 write/edit 落盘记录</div>
        <div
          v-for="f in files" :key="f.abs"
          class="ad-file" :class="{ on: activePath === f.abs }"
          :title="f.abs"
          @click="openFile(f.abs)"
        >{{ f.rel }}</div>
      </div>
      <div v-if="activePath" class="ad-sec ad-preview">
        <div class="ad-lb">预览 · {{ artRel(activePath, s.dir) }}</div>
        <div v-if="loading" class="ad-empty">读取中…</div>
        <div v-else-if="previewErr" class="ad-err">{{ previewErr }}</div>
        <pre v-else>{{ preview }}</pre>
      </div>
    </div>
  </div>
</template>
