import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ORB_STATE_ICONS, ORB_STATE_LABELS, type OrbState } from './demoViewModel';

export type OrbProfile = 'quiet' | 'active';

type Point = { x: number; y: number };

interface OrbProps {
  state: OrbState;
  profile: OrbProfile;
  onProfileChange: (profile: OrbProfile) => void;
}

const VIEWPORT_INSET = 8;
const ACTIVE_PANEL_WIDTH = 260;
const ACTIVE_PANEL_CLEARANCE = 124;
const KEYBOARD_STEP = 8;
const KEYBOARD_LARGE_STEP = 32;

function orbVisualSize(profile: OrbProfile): number {
  return profile === 'quiet' ? 26 : 96;
}

function clampPoint(point: Point, profile: OrbProfile): Point {
  const size = orbVisualSize(profile);
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const height = typeof window === 'undefined' ? 720 : window.innerHeight;
  const maxX = Math.max(VIEWPORT_INSET, width - size - VIEWPORT_INSET);
  const maxY = Math.max(VIEWPORT_INSET, height - size - VIEWPORT_INSET);
  const panelWidth = Math.min(ACTIVE_PANEL_WIDTH, width - VIEWPORT_INSET * 2);
  const requestedMinX = profile === 'active' ? VIEWPORT_INSET + panelWidth - size : VIEWPORT_INSET;
  const requestedMinY = profile === 'active' ? VIEWPORT_INSET + ACTIVE_PANEL_CLEARANCE : VIEWPORT_INSET;
  const minX = Math.min(requestedMinX, maxX);
  const minY = Math.min(requestedMinY, maxY);
  return {
    x: Math.min(Math.max(minX, point.x), maxX),
    y: Math.min(Math.max(minY, point.y), maxY),
  };
}

function defaultPoint(profile: OrbProfile): Point {
  const size = orbVisualSize(profile);
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const height = typeof window === 'undefined' ? 720 : window.innerHeight;
  return clampPoint({ x: width - size - 24, y: height - size - 24 }, profile);
}

function coarsePosition(point: Point): string {
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const height = typeof window === 'undefined' ? 720 : window.innerHeight;
  const horizontal = point.x < width / 3 ? '左侧' : point.x > (width * 2) / 3 ? '右侧' : '中间';
  const vertical = point.y < height / 3 ? '上方' : point.y > (height * 2) / 3 ? '下方' : '中部';
  return `${vertical}${horizontal}`;
}

export function Orb({ state, profile, onProfileChange }: OrbProps) {
  const [position, setPosition] = useState<Point>(() => defaultPoint(profile));
  const [moveMode, setMoveMode] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number; origin: Point } | null>(null);
  const didDragRef = useRef(false);
  const moveOriginRef = useRef<Point>(position);
  const orbButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampPoint(current, profile));
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, [profile]);

  const updatePosition = (next: Point, announce = false) => {
    const clamped = clampPoint(next, profile);
    setPosition(clamped);
    if (announce) setAnnouncement(`球体位于${coarsePosition(clamped)}`);
  };

  const startMoveMode = () => {
    moveOriginRef.current = position;
    setMoveMode(true);
    setAnnouncement('移动球体模式。使用方向键移动，回车保存，Escape 取消。');
    orbButtonRef.current?.focus();
  };

  const finishMoveMode = (save: boolean) => {
    if (!save) setPosition(moveOriginRef.current);
    setMoveMode(false);
    setAnnouncement(save ? '球体位置已保存。' : '已取消移动，位置未更改。');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!moveMode) return;
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    const delta: Point = { x: 0, y: 0 };
    if (event.key === 'ArrowLeft') delta.x = -step;
    else if (event.key === 'ArrowRight') delta.x = step;
    else if (event.key === 'ArrowUp') delta.y = -step;
    else if (event.key === 'ArrowDown') delta.y = step;
    else if (event.key === 'Enter') {
      event.preventDefault();
      finishMoveMode(true);
      return;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishMoveMode(false);
      return;
    } else return;

    event.preventDefault();
    updatePosition({ x: position.x + delta.x, y: position.y + delta.y }, true);
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (moveMode) return;
    didDragRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
      origin: position,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.offsetX - drag.origin.x) > 3 || Math.abs(event.clientY - drag.offsetY - drag.origin.y) > 3) {
      didDragRef.current = true;
    }
    updatePosition({ x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY });
  };

  const endPointerDrag = (event: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (cancelled) setPosition(drag.origin);
    else setAnnouncement(`球体已移动到${coarsePosition(position)}`);
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const resetPosition = () => {
    const next = defaultPoint(profile);
    setPosition(next);
    setAnnouncement('球体位置已重置。');
    orbButtonRef.current?.focus();
  };

  return (
    <aside
      className={`orb-dock orb-dock--${profile}`}
      style={{ left: position.x, top: position.y }}
      aria-label="ProAGI 状态球体"
    >
      <button
        ref={orbButtonRef}
        type="button"
        className={`orb orb--${state.toLowerCase()} ${moveMode ? 'orb--moving' : ''}`}
        data-profile={profile}
        data-state={state}
        aria-describedby="orb-source-description"
        aria-pressed={profile === 'active'}
        onClick={() => {
          if (didDragRef.current) {
            didDragRef.current = false;
            return;
          }
          if (!moveMode) onProfileChange(profile === 'quiet' ? 'active' : 'quiet');
        }}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => endPointerDrag(event, false)}
        onPointerCancel={(event) => endPointerDrag(event, true)}
      >
        <span className="orb__shadow" data-orb-part="shadow" aria-hidden="true" />
        <span className="orb__base-halo" data-orb-part="base-halo" aria-hidden="true" />
        <span className="orb__shell" data-orb-part="shell" aria-hidden="true" />
        <span className="orb__rim" data-orb-part="rim" aria-hidden="true" />
        <span className="orb__fluid" data-orb-part="fluid" aria-hidden="true" />
        <span className="orb__highlight orb__highlight--primary" data-orb-part="highlight-primary" aria-hidden="true" />
        <span className="orb__highlight orb__highlight--secondary" data-orb-part="highlight-secondary" aria-hidden="true" />
        <span className="orb__icon" data-orb-part="icon-lock" aria-hidden="true">{ORB_STATE_ICONS[state]}</span>
        <span className="orb__status-text">{ORB_STATE_LABELS[state]}</span>
      </button>

      <div className="orb-panel">
        <div className="orb-tools" aria-label="球体位置与尺寸控制">
          <button type="button" onClick={startMoveMode} disabled={moveMode}>移动球体</button>
          <button type="button" onClick={resetPosition}>重置位置</button>
          {moveMode ? (
            <button type="button" onClick={() => finishMoveMode(true)}>保存位置</button>
          ) : null}
        </div>
        <p id="orb-source-description" className="orb__source">来源：测试事件</p>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </aside>
  );
}
