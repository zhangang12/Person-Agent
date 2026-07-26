<script setup lang="ts">
// 工作流条(wf/orch 卡,标题栏下):
//  ① 规划闸提示 —— 方案(todowrite)出了但没实质执行时亮「批准方案 → 改」;
//  ② 自动批准开关(仅 wf 卡,用户显式开启):权限请求自动放行 once 并留痕。
import { s, approvePlan, toggleWfAutoAllow } from './store'
</script>

<template>
  <div v-if="(s.wfMode || s.orchMode) && (s.planAsk || s.wfMode)" class="wfbar">
    <template v-if="s.planAsk">
      <span class="wf-ask">方案待批准 —— 检查任务清单,没问题就开跑</span>
      <button class="wf-go" @click="approvePlan()">✓ 批准方案 → 改</button>
    </template>
    <span class="sp"></span>
    <button v-if="s.wfMode" class="wf-auto" :class="{ on: s.wfAutoAllow }" title="本工作流的写/执行权限请求自动放行(工具日志留痕)" @click="toggleWfAutoAllow">
      🤝 自动批准{{ s.wfAutoAllow ? '·开' : '' }}
    </button>
  </div>
</template>
