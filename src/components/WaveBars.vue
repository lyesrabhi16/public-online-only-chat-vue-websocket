<script setup lang="ts">
// Loudness bars, as in a voice message: the part already played is drawn solid, the rest faded.
defineProps<{ heights: number[]; progress?: number }>()
</script>

<template>
  <div class="wave" role="img" aria-hidden="true">
    <span
      v-for="(h, i) in heights"
      :key="i"
      class="bar"
      :class="{ played: progress !== undefined && progress >= 0 && (i + 0.5) / heights.length <= progress }"
      :style="{ height: Math.max(8, Math.round(h * 100)) + '%' }"
    ></span>
  </div>
</template>
