export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const escapeAttribute = escapeHtml;

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function installAccessibleModals(root = document) {
  let lastFocused = null;

  const prepare = (modal) => {
    const box = modal.querySelector('.modal-box') || modal;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    box.setAttribute('tabindex', '-1');
    const heading = box.querySelector('h1,h2,h3');
    if (heading) {
      if (!heading.id) heading.id = `${modal.id || 'modal'}-title`;
      modal.setAttribute('aria-labelledby', heading.id);
    }

    new MutationObserver(() => {
      if (modal.classList.contains('show')) {
        lastFocused = document.activeElement;
        queueMicrotask(() => (box.querySelector(FOCUSABLE) || box).focus());
      } else if (lastFocused instanceof HTMLElement && document.contains(lastFocused)) {
        lastFocused.focus();
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  };

  root.querySelectorAll('.modal').forEach(prepare);

  root.addEventListener('keydown', (event) => {
    const visible = [...root.querySelectorAll('.modal.show')].at(-1);
    if (!visible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      visible.classList.remove('show');
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = [...visible.querySelectorAll(FOCUSABLE)];
    if (!focusable.length) {
      event.preventDefault();
      visible.querySelector('.modal-box')?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
