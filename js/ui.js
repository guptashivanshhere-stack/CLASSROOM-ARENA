// ui.js — DOM rendering helpers shared across screens.
// No game rules live here — this only turns state into markup.

import { rankForRating } from './rating.js';

export function $(selector, root = document) {
  return root.querySelector(selector);
}
export function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const SCREENS = [
  'onboarding', 'auth', 'classroom', 'classroom-management', 'dashboard', 'lobby', 'game-local', 'game-online',
  'leaderboard', 'profile', 'history', 'how-to-play', 'result',
];

export function showScreen(name) {
  for (const s of SCREENS) {
    const node = document.getElementById(`screen-${s}`);
    if (node) node.hidden = s !== name;
  }
  $all('.bottom-nav__item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.screen === name);
  });
  window.scrollTo(0, 0);
}

let toastTimer = null;
export function toast(message, type = 'info') {
  const host = $('#toast-host');
  if (!host) return;
  host.textContent = message;
  host.dataset.type = type;
  host.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('is-visible'), 3200);
}

export function statusDot(status) {
  const map = { available: '🟢', in_game: '🔴', offline: '⚪' };
  return map[status] || '⚪';
}

export function statusLabel(status) {
  const map = { available: 'Available', in_game: 'In Game', offline: 'Offline' };
  return map[status] || 'Offline';
}

export function rankBadge(rating) {
  const tier = rankForRating(rating);
  return el('span', { class: 'rank-badge', style: `--tier-color:${tier.color}` }, [
    el('span', { class: 'rank-badge__name', text: tier.name }),
  ]);
}

/**
 * Renders a 3x3 board into `container` from a flat 9-cell array.
 * handlers: { onCellClick(index) }
 * extras: { selectedCell, winLine, validDestinations: Set, mySymbol }
 */
export function renderBoard(container, board, handlers = {}, extras = {}) {
  container.innerHTML = '';
  container.className = 'board';
  const { selectedCell = null, winLine = [], validDestinations = new Set(), mySymbol = null } = extras;

  board.forEach((value, i) => {
    const isWinning = winLine.includes(i);
    const isSelected = selectedCell === i;
    const isValidDest = validDestinations.has(i);
    const cell = el('button', {
      class: [
        'cell',
        value ? `cell--${value.toLowerCase()}` : 'cell--empty',
        isSelected ? 'is-selected' : '',
        isWinning ? 'is-winning' : '',
        isValidDest ? 'is-valid-target' : '',
      ].filter(Boolean).join(' '),
      type: 'button',
      'data-index': i,
      'aria-label': value ? `Cell ${i + 1}: ${value}` : `Cell ${i + 1}: empty`,
      onclick: () => handlers.onCellClick?.(i),
    });
    if (value) {
      cell.appendChild(el('span', { class: 'cell__piece', text: value }));
    }
    container.appendChild(cell);
  });
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatRelativeDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
