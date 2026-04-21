import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../lib/i18n';

type GraphNode = { id: string; title: string; modified: number };
type GraphEdge = { src: string; dst: string; display: string | null };
type GraphResponse = { nodes: GraphNode[]; edges: GraphEdge[] };

type NodeTagMap = Map<string, string[]>;

type Props = {
  graph: GraphResponse | null;
  selected: string | null;
  onSelect: (path: string) => void;
  nodeTags?: NodeTagMap;
  folderColor: (folder: string) => string;
  folderFromPath: (path: string) => string;
  titleFromPath: (path: string) => string;
  height?: number;
};

type Position = { x: number; y: number; vx: number; vy: number; fixed: boolean };

type SimNode = {
  id: string;
  title: string;
  folder: string;
  degree: number;
  radius: number;
  color: string;
};

const REPULSION = 6500;
const SPRING_K = 0.025;
const SPRING_REST = 90;
const CENTER_K = 0.0045;
const DAMPING = 0.84;
const MAX_V = 22;
const STOP_ENERGY = 0.25;
const MAX_TICKS = 900;

export function VaultGraphCanvas({
  graph,
  selected,
  onSelect,
  nodeTags,
  folderColor,
  folderFromPath,
  titleFromPath,
  height = 540,
}: Props) {
  const { t } = useTranslation();
  const [hiddenFolders, setHiddenFolders] = useState<Set<string>>(new Set());
  const [minDegree, setMinDegree] = useState(0);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [depth, setDepth] = useState(0);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [labelMode, setLabelMode] = useState<'hubs' | 'hover' | 'all'>('hubs');

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [, setFrameNonce] = useState(0);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const posRef = useRef<Map<string, Position>>(new Map());
  const tickCountRef = useRef(0);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const panDragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null,
  );

  const rawNodes = graph?.nodes || [];
  const rawEdges = graph?.edges || [];

  const degreeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const edge of rawEdges) {
      m.set(edge.src, (m.get(edge.src) || 0) + 1);
      m.set(edge.dst, (m.get(edge.dst) || 0) + 1);
    }
    return m;
  }, [rawEdges]);

  const foldersWithCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const node of rawNodes) {
      const folder = folderFromPath(node.id) || '(racine)';
      m.set(folder, (m.get(folder) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rawNodes, folderFromPath]);

  const allTags = useMemo(() => {
    if (!nodeTags) return [] as Array<[string, number]>;
    const m = new Map<string, number>();
    for (const tags of nodeTags.values()) {
      for (const tag of tags) {
        m.set(tag, (m.get(tag) || 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  }, [nodeTags]);

  const filtered = useMemo(() => {
    let allowed = new Set<string>(rawNodes.map((n) => n.id));

    if (depth > 0 && selected) {
      const adj = new Map<string, Set<string>>();
      for (const edge of rawEdges) {
        if (!adj.has(edge.src)) adj.set(edge.src, new Set());
        if (!adj.has(edge.dst)) adj.set(edge.dst, new Set());
        adj.get(edge.src)?.add(edge.dst);
        adj.get(edge.dst)?.add(edge.src);
      }
      const visited = new Set<string>([selected]);
      const queue: Array<[string, number]> = [[selected, 0]];
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        const [id, d] = next;
        if (d >= depth) continue;
        for (const neighbor of adj.get(id) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push([neighbor, d + 1]);
          }
        }
      }
      allowed = visited;
    }

    const nodes: SimNode[] = [];
    for (const node of rawNodes) {
      if (!allowed.has(node.id)) continue;
      const folder = folderFromPath(node.id) || '(racine)';
      if (hiddenFolders.has(folder)) continue;
      const degree = degreeMap.get(node.id) || 0;
      if (degree < minDegree) continue;
      if (hideOrphans && degree === 0) continue;
      if (tagFilter) {
        const tags = nodeTags?.get(node.id) || [];
        if (!tags.includes(tagFilter)) continue;
      }
      const radius = 4 + Math.log2(degree + 2) * 3.2;
      nodes.push({
        id: node.id,
        title: node.title || titleFromPath(node.id),
        folder,
        degree,
        radius,
        color: folderColor(folder),
      });
    }

    const nodeSet = new Set(nodes.map((n) => n.id));
    const edges = rawEdges.filter((edge) => nodeSet.has(edge.src) && nodeSet.has(edge.dst));

    return { nodes, edges };
  }, [
    rawNodes,
    rawEdges,
    hiddenFolders,
    minDegree,
    hideOrphans,
    depth,
    selected,
    degreeMap,
    tagFilter,
    nodeTags,
    folderFromPath,
    folderColor,
    titleFromPath,
  ]);

  // (Re)seed positions for new nodes, prune stale ones.
  useEffect(() => {
    const map = posRef.current;
    const valid = new Set(filtered.nodes.map((n) => n.id));
    for (const id of [...map.keys()]) {
      if (!valid.has(id)) map.delete(id);
    }
    const count = filtered.nodes.length;
    let seedIndex = 0;
    for (const node of filtered.nodes) {
      if (!map.has(node.id)) {
        const angle = (seedIndex / Math.max(1, count)) * Math.PI * 2;
        const radius = 60 + Math.random() * 140;
        map.set(node.id, {
          x: Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
          y: Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
          vx: 0,
          vy: 0,
          fixed: false,
        });
      }
      seedIndex += 1;
    }
    tickCountRef.current = 0;
  }, [filtered]);

  // Simulation loop via requestAnimationFrame.
  useEffect(() => {
    let rafId = 0;
    let alive = true;

    function step() {
      if (!alive) return;
      const pos = posRef.current;
      const nodes = filtered.nodes;
      const edges = filtered.edges;
      if (nodes.length === 0) {
        return;
      }
      const ids = nodes.map((n) => n.id);

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos.get(ids[i]);
          const b = pos.get(ids[j]);
          if (!a || !b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 1) dist2 = 1;
          const dist = Math.sqrt(dist2);
          const force = REPULSION / dist2;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const edge of edges) {
        const a = pos.get(edge.src);
        const b = pos.get(edge.dst);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const disp = dist - SPRING_REST;
        const fx = (dx / dist) * disp * SPRING_K;
        const fy = (dy / dist) * disp * SPRING_K;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }

      for (const id of ids) {
        const p = pos.get(id);
        if (!p) continue;
        p.vx -= p.x * CENTER_K;
        p.vy -= p.y * CENTER_K;
      }

      let energy = 0;
      for (const id of ids) {
        const p = pos.get(id);
        if (!p) continue;
        if (!p.fixed) {
          p.vx = Math.max(-MAX_V, Math.min(MAX_V, p.vx * DAMPING));
          p.vy = Math.max(-MAX_V, Math.min(MAX_V, p.vy * DAMPING));
          p.x += p.vx;
          p.y += p.vy;
        } else {
          p.vx = 0;
          p.vy = 0;
        }
        energy += p.vx * p.vx + p.vy * p.vy;
      }

      tickCountRef.current += 1;
      setFrameNonce((n) => (n + 1) % 1_000_000);

      if (energy > STOP_ENERGY && tickCountRef.current < MAX_TICKS) {
        rafId = requestAnimationFrame(step);
      }
    }

    rafId = requestAnimationFrame(step);
    return () => {
      alive = false;
      cancelAnimationFrame(rafId);
    };
  }, [filtered]);

  const fitToView = useCallback(() => {
    const pos = posRef.current;
    if (pos.size === 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of pos.values()) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const w = svgRef.current?.clientWidth || 800;
    const h = svgRef.current?.clientHeight || height;
    const graphW = Math.max(100, maxX - minX + 160);
    const graphH = Math.max(100, maxY - minY + 160);
    const z = Math.min(w / graphW, h / graphH, 2.5);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    setZoom(z);
    setPan({ x: -centerX * z, y: -centerY * z });
  }, [height]);

  const resetLayout = useCallback(() => {
    posRef.current.clear();
    setZoom(1);
    setPan({ x: 0, y: 0 });
    tickCountRef.current = 0;
    setFrameNonce((n) => n + 1);
  }, []);

  // Native non-passive wheel listener. React's onWheel is passive since v17,
  // so preventDefault() there is a no-op and the page scrolls at the same
  // time the map zooms — hence the "scroll ⇒ zooms carte" double effect.
  // Scope: only zoom when Cmd/Ctrl is held; bare wheel scrolls the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = -event.deltaY * 0.0015;
      setZoom((z) => Math.max(0.2, Math.min(4, z * (1 + delta))));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const handleNodePointerDown = (event: React.PointerEvent<SVGGElement>, id: string) => {
    event.stopPropagation();
    const p = posRef.current.get(id);
    if (!p) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = rect.width / 2 + pan.x;
    const cy = rect.height / 2 + pan.y;
    const pointerX = (event.clientX - rect.left - cx) / zoom;
    const pointerY = (event.clientY - rect.top - cy) / zoom;
    dragRef.current = { id, offsetX: pointerX - p.x, offsetY: pointerY - p.y };
    p.fixed = true;
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();

    if (dragRef.current) {
      const p = posRef.current.get(dragRef.current.id);
      if (!p) return;
      const cx = rect.width / 2 + pan.x;
      const cy = rect.height / 2 + pan.y;
      const pointerX = (event.clientX - rect.left - cx) / zoom;
      const pointerY = (event.clientY - rect.top - cy) / zoom;
      p.x = pointerX - dragRef.current.offsetX;
      p.y = pointerY - dragRef.current.offsetY;
      p.vx = 0;
      p.vy = 0;
      tickCountRef.current = 0;
      setFrameNonce((n) => n + 1);
      return;
    }

    if (panDragRef.current) {
      const dx = event.clientX - panDragRef.current.startX;
      const dy = event.clientY - panDragRef.current.startY;
      setPan({
        x: panDragRef.current.panX + dx,
        y: panDragRef.current.panY + dy,
      });
    }
  };

  const handlePointerUp = (_event: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) {
      const p = posRef.current.get(dragRef.current.id);
      if (p) p.fixed = false;
      dragRef.current = null;
      tickCountRef.current = 0;
    }
    panDragRef.current = null;
  };

  const handleBackgroundPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).tagName !== 'svg') return;
    panDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const maxDegree = useMemo(
    () => filtered.nodes.reduce((m, n) => Math.max(m, n.degree), 0),
    [filtered.nodes],
  );

  const labelThreshold = Math.max(
    0,
    Math.round(maxDegree * (zoom > 1.6 ? 0.1 : zoom > 1.0 ? 0.35 : 0.6)),
  );

  const toggleFolder = (folder: string) => {
    setHiddenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const resetFilters = () => {
    setHiddenFolders(new Set());
    setMinDegree(0);
    setHideOrphans(false);
    setDepth(0);
    setTagFilter(null);
  };

  const selectedFolder = selected ? folderFromPath(selected) : '';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
            {t('vault.graphFilters.folders')}
          </span>
          {foldersWithCount.map(([folder, count]) => {
            const hidden = hiddenFolders.has(folder);
            return (
              <button
                key={folder}
                type="button"
                onClick={() => toggleFolder(folder)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] transition ${hidden ? 'border-[var(--border)] bg-transparent text-[var(--text-faint)] line-through' : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)]'}`}
                aria-pressed={!hidden}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: folderColor(folder), opacity: hidden ? 0.3 : 1 }}
                />
                {folder}
                <span className="num text-[9px] text-[var(--text-faint)]">{count}</span>
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
          <span className="uppercase tracking-[0.08em]">{t('vault.graphFilters.minDegree')}</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, maxDegree)}
            value={minDegree}
            onChange={(event) => setMinDegree(Number(event.target.value))}
            className="w-20 accent-[var(--accent)]"
          />
          <span className="num text-[11px] text-[var(--text)]">{minDegree}</span>
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
          <span className="uppercase tracking-[0.08em]">{t('vault.graphFilters.depth')}</span>
          <input
            type="range"
            min={0}
            max={4}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            className="w-16 accent-[var(--accent)]"
            disabled={!selected}
          />
          <span className="num text-[11px] text-[var(--text)]">
            {depth === 0
              ? t('vault.graphFilters.depthGlobal')
              : t('vault.graphFilters.depthSign', { n: depth })}
          </span>
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
          <input
            type="checkbox"
            checked={hideOrphans}
            onChange={(event) => setHideOrphans(event.target.checked)}
            className="accent-[var(--accent)]"
          />
          {t('vault.graphFilters.hideOrphans')}
        </label>

        <div className="flex items-center gap-1 text-[11px] text-[var(--text-dim)]">
          <span className="uppercase tracking-[0.08em]">{t('vault.graphFilters.labels')}</span>
          {(['hubs', 'hover', 'all'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setLabelMode(mode)}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] ${labelMode === mode ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]' : 'border-[var(--border)] text-[var(--text-faint)] hover:border-[var(--border-strong)]'}`}
            >
              {mode === 'hubs'
                ? t('vault.graphFilters.labelHubs')
                : mode === 'hover'
                  ? t('vault.graphFilters.labelHover')
                  : t('vault.graphFilters.labelAll')}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {allTags.length > 0 ? (
            <select
              value={tagFilter || ''}
              onChange={(event) => setTagFilter(event.target.value || null)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10.5px] text-[var(--text)]"
            >
              <option value="">{t('vault.graphFilters.allTags')}</option>
              {allTags.map(([tag, count]) => (
                <option key={tag} value={tag}>
                  #{tag} · {count}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            onClick={resetFilters}
            className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10.5px] text-[var(--text-faint)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          >
            {t('vault.graphFilters.resetFilters')}
          </button>
        </div>
      </div>

      <div
        className="relative overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-alt)]"
        style={{ height }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          onPointerDown={handleBackgroundPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          style={{ display: 'block', cursor: panDragRef.current ? 'grabbing' : 'grab' }}
        >
          <title>{t('vault.graphFilters.svgTitle')}</title>
          <g
            transform={`translate(${(svgRef.current?.clientWidth || 800) / 2 + pan.x}, ${(svgRef.current?.clientHeight || height) / 2 + pan.y}) scale(${zoom})`}
          >
            {filtered.edges.map((edge, index) => {
              const a = posRef.current.get(edge.src);
              const b = posRef.current.get(edge.dst);
              if (!a || !b) return null;
              const isTouchSelected = selected && (edge.src === selected || edge.dst === selected);
              const isTouchHovered =
                hoveredId && (edge.src === hoveredId || edge.dst === hoveredId);
              const highlight = isTouchSelected || isTouchHovered;
              return (
                <line
                  key={`${edge.src}-${edge.dst}-${index}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={highlight ? 'rgba(100,210,255,0.6)' : 'rgba(255,255,255,0.08)'}
                  strokeWidth={highlight ? 1.25 / zoom : 0.7 / zoom}
                />
              );
            })}

            {filtered.nodes.map((node) => {
              const pos = posRef.current.get(node.id);
              if (!pos) return null;
              const isSelected = selected === node.id;
              const isHovered = hoveredId === node.id;
              const showLabel =
                labelMode === 'all' ||
                isSelected ||
                isHovered ||
                (labelMode === 'hubs' && node.degree >= labelThreshold && node.degree > 0);
              const outlineColor = isSelected
                ? 'var(--accent)'
                : isHovered
                  ? 'rgba(255,255,255,0.55)'
                  : 'rgba(0,0,0,0.25)';
              const outlineWidth = isSelected ? 2.2 : isHovered ? 1.6 : 0.8;
              const labelOpacity = isSelected ? 1 : isHovered ? 1 : Math.min(1, 0.3 + zoom * 0.4);

              return (
                <g
                  key={node.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                  onPointerEnter={() => setHoveredId(node.id)}
                  onPointerLeave={() => setHoveredId((curr) => (curr === node.id ? null : curr))}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(node.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect(node.id);
                    }
                  }}
                  // biome-ignore lint/a11y/useSemanticElements: inside an SVG — native <button> isn't an SVG element, role="button" is the ARIA-correct pattern here
                  role="button"
                  tabIndex={0}
                  aria-label={node.title}
                  style={{ cursor: 'pointer' }}
                >
                  <circle
                    r={node.radius}
                    fill={node.color}
                    fillOpacity={isSelected || isHovered ? 0.95 : 0.78}
                    stroke={outlineColor}
                    strokeWidth={outlineWidth / zoom}
                  />
                  {showLabel ? (
                    <text
                      x={node.radius + 4}
                      y={3}
                      fontSize={11 / Math.max(0.6, zoom)}
                      fontWeight={isSelected ? 600 : 500}
                      fill={isSelected ? 'var(--accent)' : 'var(--text)'}
                      style={{ pointerEvents: 'none', opacity: labelOpacity }}
                    >
                      {node.title.length > 32 ? `${node.title.slice(0, 30)}…` : node.title}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute inset-0">
          <div className="pointer-events-auto absolute right-2 top-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.2, z / 1.2))}
              className="h-7 w-7 rounded-full border border-[var(--border)] bg-[var(--surface-1)] text-[12px] text-[var(--text)] hover:border-[var(--border-strong)]"
              aria-label={t('vault.graphFilters.zoomOut')}
            >
              −
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(4, z * 1.2))}
              className="h-7 w-7 rounded-full border border-[var(--border)] bg-[var(--surface-1)] text-[12px] text-[var(--text)] hover:border-[var(--border-strong)]"
              aria-label={t('vault.graphFilters.zoomIn')}
            >
              +
            </button>
            <button
              type="button"
              onClick={fitToView}
              className="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-0.5 text-[10.5px] text-[var(--text)] hover:border-[var(--border-strong)]"
            >
              {t('vault.graphFilters.fit')}
            </button>
            <button
              type="button"
              onClick={resetLayout}
              className="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-0.5 text-[10.5px] text-[var(--text-faint)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              {t('vault.graphFilters.resetLayout')}
            </button>
          </div>

          <div className="pointer-events-none absolute bottom-2 left-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)]/80 px-2 py-1 text-[10px] text-[var(--text-faint)]">
            <span className="num text-[var(--text-dim)]">{filtered.nodes.length}</span>{' '}
            {t('vault.graphFilters.footerNodes')} ·{' '}
            <span className="num text-[var(--text-dim)]">{filtered.edges.length}</span>{' '}
            {t('vault.graphFilters.footerLinks')} · {t('vault.graphFilters.footerZoom')}{' '}
            <span className="num">{zoom.toFixed(2)}×</span>
            {selected ? (
              <>
                {' · '}
                {t('vault.graphFilters.selection')}{' '}
                <span className="text-[var(--text)]">{titleFromPath(selected)}</span>
                {selectedFolder ? (
                  <span className="text-[var(--text-faint)]"> ({selectedFolder})</span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
