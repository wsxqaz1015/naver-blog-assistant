// 발행 차단 안전장치.
// 자동화 브라우저 안에서 "발행"이라는 글자나 publish/confirm 이름이 붙은 버튼은 클릭이 막혀요.
// 예외는 단 하나: 태그 입력 창을 열기 위해 상단 발행 버튼(publish_btn)을 '한 번' 여는 경우뿐이고,
// 이것도 프로그램이 allowPublishPanelOpenOnce()를 부른 직후에만 허용돼요.
// 설정 창 안의 최종 발행 버튼은 어떤 경우에도 막혀요.

const GUARD_SCRIPT = `(() => {
  if (window.__btGuardInstalled) return;
  window.__btGuardInstalled = true;
  window.__btBlocked = [];
  const find = (el) => {
    if (!el || !el.closest) return null;
    const b = el.closest('button, a, [role=button], label, input[type=submit], input[type=button]');
    if (!b) return null;
    const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\\s+/g, '');
    const cls = String(b.className || '');
    if (/발행/.test(t) || /publish|confirm_btn/i.test(cls)) return b;
    // 임시저장 목록 등에서 글을 지우는 버튼도 막아요 (예: button.delete_button__… title="삭제")
    if (/^(삭제|전체삭제|선택삭제)$/.test(t) || /삭제/.test(b.getAttribute('title') || '') || /delete/i.test(cls) || /delete/i.test(b.id || '')) return b;
    return null;
  };
  const isTopPublish = (b) => /^publish_btn/.test(String(b.className || ''));
  const handler = (e) => {
    const b = find(e.target);
    if (!b) return;
    if (window.__btAllowPublishOpen && isTopPublish(b)) {
      if (e.type === 'click') window.__btAllowPublishOpen = false;
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') {
      window.__btBlocked.push({ text: (b.innerText || '').trim().slice(0, 30), cls: String(b.className).slice(0, 60), at: Date.now() });
      console.warn('[안전장치] 발행 관련 클릭을 막았어요:', b.className, b.innerText);
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, handler, true);
  }
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && find(document.activeElement)) {
      e.preventDefault(); e.stopImmediatePropagation();
      window.__btBlocked.push({ text: 'keyboard', cls: String(document.activeElement.className).slice(0, 60), at: Date.now() });
    }
  }, true);
})();`;

export async function installGuard(context) {
  await context.addInitScript(GUARD_SCRIPT);
  for (const p of context.pages()) await p.evaluate(GUARD_SCRIPT).catch(() => {});
}

export async function allowPublishPanelOpenOnce(page) {
  await page.evaluate(() => { window.__btAllowPublishOpen = true; });
}

export async function blockedClicks(page) {
  return page.evaluate(() => window.__btBlocked || []);
}

// Node 쪽 이중 확인: 클릭 전에 버튼 글자를 보고 발행 관련이면 거부
export async function safeClick(locator, { allowTopPublish = false } = {}) {
  const info = await locator.evaluate((el) => {
    const b = el.closest('button, a, [role=button], label') || el;
    return { text: (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ''), cls: String(b.className || ''), title: b.getAttribute('title') || '', id: b.id || '' };
  });
  if (/삭제/.test(info.title) || /delete/i.test(info.cls) || /delete/i.test(info.id)) {
    throw new Error(`[안전장치] 삭제 버튼이라 클릭하지 않았어요: "${info.title || info.text}"`);
  }
  const publishLike = /발행/.test(info.text) || /publish|confirm_btn/i.test(info.cls);
  if (publishLike && !(allowTopPublish && /^publish_btn/.test(info.cls))) {
    throw new Error(`[안전장치] 발행 관련 버튼이라 클릭하지 않았어요: "${info.text}" (${info.cls})`);
  }
  if (/^(삭제|전체삭제|선택삭제)$/.test(info.text) || /(^|\s|_)(delete|del)_?btn/i.test(info.cls)) {
    throw new Error(`[안전장치] 삭제 버튼이라 클릭하지 않았어요: "${info.text}"`);
  }
  await locator.click();
}
