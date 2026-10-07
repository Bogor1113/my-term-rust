/**
 * 迷你趋势曲线：网格 + 平滑曲线 + 面积填充 + 最新值端点。
 *
 * 原本是 `ResourceMonitor` 的模块私有实现；集群面板要用同一套趋势呈现，
 * 因此抽成公共组件（避免复制一份导致两边漂移）。
 * `className` 由调用方决定尺寸/边距（默认沿用底部状态条的 `rm-chart`）。
 * `series` 支持单线或双线（如网络下行/上行）。
 */

/** Catmull-Rom 样条 → 三次贝塞尔路径，让折线变为平滑曲线 */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 3) {
    return `M${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L')}`;
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

export function Spark({
  series,
  max,
  className = 'rm-chart',
}: {
  series: { values: number[]; color: string }[];
  max: number;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const n = series[0]?.values.length ?? 0;
  const toY = (v: number) => 19 - (Math.min(Math.max(v, 0), safeMax) / safeMax) * 17; // y: 2..19
  return (
    <svg className={className} viewBox="0 0 100 20" preserveAspectRatio="none">
      {/* 网格：3 横 3 竖（25%/50%/75%） */}
      <g stroke="rgba(255,255,255,0.07)" strokeWidth="1" vectorEffect="non-scaling-stroke">
        <line x1="0" y1="5" x2="100" y2="5" />
        <line x1="0" y1="10" x2="100" y2="10" />
        <line x1="0" y1="15" x2="100" y2="15" />
        <line x1="25" y1="0" x2="25" y2="20" />
        <line x1="50" y1="0" x2="50" y2="20" />
        <line x1="75" y1="0" x2="75" y2="20" />
      </g>
      {series.map((s, si) => {
        if (s.values.length === 0) return null;
        const pts: [number, number][] = s.values.map((v, i) => {
          const x = n <= 1 ? 100 : (i / (n - 1)) * 100;
          return [x, toY(v)];
        });
        const lineD = smoothPath(pts);
        // 面积：左下角出发沿曲线到右下角，闭合
        const areaD = `M0,20 ${lineD.slice(1)} L100,20 Z`;
        return (
          <g key={si}>
            <path d={areaD} fill={s.color} opacity={0.13} />
            <path
              d={lineD}
              fill="none"
              stroke={s.color}
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
      {series.map((s, si) => {
        if (s.values.length === 0) return null;
        // 最新值端点：用纵向短线 + 圆头描边，避免 preserveAspectRatio="none" 把圆点拉成椭圆
        const y = toY(s.values[s.values.length - 1]);
        return (
          <path
            key={`dot${si}`}
            d={`M100 ${y - 1.2} L100 ${y + 1.2}`}
            stroke={s.color}
            strokeWidth="2.6"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
        );
      })}
    </svg>
  );
}
