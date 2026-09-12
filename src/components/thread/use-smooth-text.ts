"use client";

import { useEffect, useState } from "react";

/**
 * 打字机平滑显示（display-only）：transcripts 里的完整内容始终是权威值，
 * 这里只控制"揭示"的节奏，不影响持久化、停止与对账逻辑。
 *
 * 揭示速率 = 基础打字速率 + 缺口比例追赶：
 *  - 慢速流式（普通模型每秒几十字）：逐字跟显，几乎无延迟；
 *  - 高速突发（flash 模型每秒数百字）：以恒定时滞平滑追赶，而不是把
 *    一大段文本一次性砸出来——这正是"看得到流式"的关键。
 * 流结束/停止后，剩余缺口按同一公式排空（时间常数 ≈ 1/CATCHUP_PER_SEC 秒）。
 */

/** 基础揭示下限（字/秒）：保证很小的缺口也呈现连续打字感。 */
const BASE_CHARS_PER_SEC = 30;
/** 每秒追赶缺口的倍数：稳态时滞 ≈ 到达速率 / 该值。 */
const CATCHUP_PER_SEC = 6;
/** 单帧dt上限：标签页隐藏后恢复时避免一步跳到底。 */
const MAX_DT_SECONDS = 0.25;

export function useSmoothText(target: string): string {
  // 挂载时已有内容（历史回放、流中切走再切回）：直接全量显示，不重放打字。
  const [shownLen, setShownLen] = useState(() => target.length);

  useEffect(() => {
    if (shownLen >= target.length) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, MAX_DT_SECONDS);
      last = now;
      setShownLen((prev) => {
        if (prev >= target.length) return prev;
        const step = Math.max(
          BASE_CHARS_PER_SEC * dt,
          (target.length - prev) * CATCHUP_PER_SEC * dt,
        );
        return Math.min(target.length, prev + step);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shownLen, target]);

  return target.slice(0, shownLen);
}
