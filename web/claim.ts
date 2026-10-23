/**
 * Клейм волонтёра: отправка 0.01 TON на owner DAO с комментарием
 * `dobro/claim/1 …`. Sender транзакции — адрес получателя BLG.
 */

import { Address } from '@ton/core';

import { encodeClaim } from '../lib/claims.ts';
import type { OrgSnapshot } from '../lib/snapshot.ts';
import { textCommentPayload, toFriendlyAddress } from '../lib/ton-comment.ts';

const ORG_ID = Number(new URL(location.href).searchParams.get('org') ?? 10072836);
const CLAIM_AMOUNT = '10000000';
const VALID_FOR_SECONDS = 300;

interface Wallet {
  account: { address: string; chain: string };
}

interface TonConnectUIInstance {
  account: Wallet['account'] | null;
  connected: boolean;
  uiOptions: Record<string, unknown>;
  setConnectionNetwork(chainId: string | undefined): void;
  onStatusChange(callback: (wallet: Wallet | null) => void): () => void;
  sendTransaction(tx: {
    validUntil: number;
    messages: Array<{ address: string; amount: string; payload?: string }>;
  }): Promise<{ boc: string }>;
}

declare global {
  interface Window {
    TON_CONNECT_UI?: {
      TonConnectUI: new (options: {
        manifestUrl: string;
        buttonRootId?: string;
        analytics?: { mode: 'off' | 'telemetry' | 'full' };
      }) => TonConnectUIInstance;
    };
  }
}

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Нет элемента #${id}`);
  return element;
}

function rawAddress(value: string): string | null {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return null;
  }
}

function sameAddress(a: string | null, b: string | null): boolean {
  const left = a ? rawAddress(a) : null;
  const right = b ? rawAddress(b) : null;
  return Boolean(left && right && left === right);
}

function shortAddress(value: string, size = 6): string {
  return value.length > size * 2 + 1 ? `${value.slice(0, size)}…${value.slice(-size)}` : value;
}

function setStatus(text: string, kind: 'muted' | 'err' | 'ok' = 'muted'): HTMLElement {
  const status = $('status');
  status.className = `hint ${kind === 'muted' ? '' : kind}`.trim();
  status.textContent = text;
  return status;
}

let snapshot: OrgSnapshot | null = null;
let wallet: Wallet | null = null;
let tonConnect: TonConnectUIInstance | null = null;

function defaultPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function loadSnapshot(): Promise<void> {
  const box = $('org');
  try {
    const url = new URL(`data/orgs/${ORG_ID}.json`, location.href);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snapshot = (await res.json()) as OrgSnapshot;

    box.textContent = '';
    const title = document.createElement('h2');
    title.textContent = snapshot.name ?? `Организация ${ORG_ID}`;
    box.append(title);

    const rows: Array<[string, string]> = [
      ['DAO', snapshot.dao],
      ['Owner DAO', snapshot.daoOwner ?? '—'],
    ];
    for (const [key, value] of rows) {
      const row = document.createElement('div');
      row.className = 'kv';
      const k = document.createElement('div');
      k.className = 'k';
      k.textContent = key;
      const v = document.createElement('div');
      v.className = 'v';
      v.textContent = shortAddress(value, 8);
      v.title = value;
      row.append(k, v);
      box.append(row);
    }

    if (!snapshot.verified) {
      const warn = document.createElement('p');
      warn.className = 'warn';
      warn.textContent = 'Организация не верифицирована на dobro.ru — клейм недоступен.';
      box.append(warn);
    }
    if (!snapshot.daoOwner) {
      const warn = document.createElement('p');
      warn.className = 'warn';
      warn.textContent = 'В снапшоте нет owner DAO — клейм недоступен.';
      box.append(warn);
    }
  } catch (err) {
    box.textContent = `Не удалось загрузить снапшот: ${err instanceof Error ? err.message : String(err)}`;
    box.className = 'card err';
  }
  renderWallet();
}

function canSend(): boolean {
  if (!snapshot?.verified || !snapshot.daoOwner) return false;
  if (!wallet || wallet.account.chain !== '-239') return false;
  return !sameAddress(wallet.account.address, snapshot.daoOwner);
}

function renderWallet(): void {
  const box = $('wallet');
  const send = $('send') as HTMLButtonElement;

  if (!wallet) {
    box.className = 'hint';
    box.textContent = 'Кошелёк не подключён. Подключите кошелёк волонтёра.';
    send.disabled = true;
    return;
  }
  if (wallet.account.chain !== '-239') {
    box.className = 'hint err';
    box.textContent = 'Подключён тестнет-кошелёк. Нужен mainnet.';
    send.disabled = true;
    return;
  }
  if (snapshot?.daoOwner && sameAddress(wallet.account.address, snapshot.daoOwner)) {
    box.className = 'hint err';
    box.textContent = 'Это кошелёк owner DAO. Клейм отправляет волонтёр со своего кошелька.';
    send.disabled = true;
    return;
  }

  box.className = 'hint ok';
  box.textContent = `Кошелёк волонтёра: ${shortAddress(wallet.account.address)}`;
  send.disabled = !canSend();
}

function initTonConnect(): void {
  const lib = window.TON_CONNECT_UI;
  if (!lib) {
    setStatus('TON Connect UI не загрузился: проверьте public/vendor/tonconnect-ui.min.js', 'err');
    return;
  }

  try {
    const manifestUrl = new URL('tonconnect-manifest.json', location.href).href;
    tonConnect = new lib.TonConnectUI({
      manifestUrl,
      buttonRootId: 'ton-connect',
      analytics: { mode: 'off' },
    });
    tonConnect.uiOptions = {
      language: 'ru',
      uiPreferences: { theme: 'DARK', borderRadius: 's' },
    };
    try {
      tonConnect.setConnectionNetwork('-239');
    } catch {
      // сессия уже восстановлена — сеть проверим по account.chain
    }
    tonConnect.onStatusChange((next) => {
      wallet = next;
      renderWallet();
    });
  } catch (err) {
    setStatus(`TON Connect: ${err instanceof Error ? err.message : String(err)}`, 'err');
  }
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!snapshot || !tonConnect || !wallet) return;
  if (!canSend() || !snapshot.daoOwner) {
    setStatus('Проверьте кошелёк и снапшот организации.', 'err');
    return;
  }

  const volunteerId = Number(($('volunteer') as HTMLInputElement).value);
  const period = ($('period') as HTMLInputElement).value;
  let comment: string;
  try {
    comment = encodeClaim({ version: 1, orgId: ORG_ID, volunteerId, period });
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Некорректные данные', 'err');
    return;
  }

  const send = $('send') as HTMLButtonElement;
  send.disabled = true;
  setStatus('Ожидайте подтверждения в кошельке…');

  try {
    await tonConnect.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + VALID_FOR_SECONDS,
      messages: [
        {
          address: toFriendlyAddress(snapshot.daoOwner),
          amount: CLAIM_AMOUNT,
          payload: textCommentPayload(comment),
        },
      ],
    });

    localStorage.setItem(
      'dobro:lastClaim',
      JSON.stringify({ comment, wallet: wallet.account.address, at: new Date().toISOString() }),
    );

    const status = setStatus('Клейм отправлен. ', 'ok');
    const code = document.createElement('code');
    code.textContent = comment;
    status.append(code);
    const link = document.createElement('a');
    link.href = `https://tonviewer.com/${toFriendlyAddress(wallet.account.address)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = ' история кошелька';
    status.append(link);
  } catch (err) {
    const name = err && typeof err === 'object' ? (err as { name?: string }).name : '';
    const message = err instanceof Error ? err.message : String(err);
    setStatus(
      name === 'UserRejectsError' ? 'Вы отклонили подпись в кошельке.' : `Не отправлено: ${message}`,
      'err',
    );
  } finally {
    renderWallet();
  }
}

function init(): void {
  ($('period') as HTMLInputElement).value = defaultPeriod();
  ($('form') as HTMLFormElement).addEventListener('submit', (event) => {
    void submit(event);
  });
  initTonConnect();
  void loadSnapshot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
