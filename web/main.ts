/**
 * Local-first UI: сверка owner DAO и отправка аттестации часов в TON.
 * TON Connect UI грузится отдельным UMD-бандлом (public/vendor), здесь —
 * только бизнес-логика и сборка payload через @ton/core.
 */

import { Address } from '@ton/core';

import {
  claimAmount,
  encodeAttestation,
  normalizeHours,
  type OrgSnapshot,
} from '../lib/snapshot.ts';
import { textCommentPayload } from '../lib/ton-comment.ts';

const ORG_ID = Number(new URL(location.href).searchParams.get('org') ?? 10072836);
const TON_VOTE = 'https://api.ton.vote';
const SELF_TX_AMOUNT = '10000000'; // 0.01 TON; вернётся на свой адрес за вычетом комиссии
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

let snapshot: OrgSnapshot | null = null;
let wallet: Wallet | null = null;
let owner: string | null = null;
let ownerIsLive = false;
let tonConnect: TonConnectUIInstance | null = null;

function setStatus(text: string, kind: 'muted' | 'err' | 'ok' = 'muted'): HTMLElement {
  const status = $('status');
  status.className = `hint ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''}`;
  status.replaceChildren(document.createTextNode(text));
  return status;
}

function kv(parent: HTMLElement, label: string, value: string, mono = false): void {
  const row = document.createElement('div');
  row.className = 'kv';
  const key = document.createElement('span');
  key.className = 'k';
  key.textContent = label;
  const val = document.createElement(mono ? 'code' : 'span');
  val.className = 'v';
  val.textContent = value;
  row.append(key, val);
  parent.append(row);
}

async function loadSnapshot(): Promise<OrgSnapshot> {
  const response = await fetch(`/data/orgs/${ORG_ID}.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Нет снапшота для организации ${ORG_ID}`);
  return (await response.json()) as OrgSnapshot;
}

async function fetchLiveOwner(dao: string): Promise<string | null> {
  try {
    const response = await fetch(`${TON_VOTE}/dao/${encodeURIComponent(dao)}`, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      daoRoles?: { owner?: string | null } | null;
      owner?: string | null;
    };
    return data.daoRoles?.owner ?? data.owner ?? null;
  } catch {
    return null;
  }
}

function renderOrg(): void {
  const card = $('org');
  card.replaceChildren();
  if (!snapshot) return;

  const title = document.createElement('h2');
  title.textContent = snapshot.name ?? `Организация ${ORG_ID}`;
  card.append(title);

  kv(card, 'DAO', snapshot.dao, true);
  kv(card, 'Owner', owner ?? '—', true);
  kv(card, 'Жетон', snapshot.jetton ?? '—', true);
  kv(card, 'Документ', snapshot.doc?.name ?? '—');
  kv(card, 'sha256', snapshot.doc?.sha256 ?? '—', true);

  if (snapshot.doc?.url) {
    const link = document.createElement('a');
    link.href = snapshot.doc.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Открыть документ';
    link.className = 'doc-link';
    card.append(link);
  }

  const note = document.createElement('p');
  note.className = 'hint';
  const fetched = new Date(snapshot.fetchedAt).toLocaleString('ru-RU');
  note.textContent = ownerIsLive
    ? `Снапшот от ${fetched}. Owner прочитан из сети.`
    : `Снапшот от ${fetched}. Owner из снапшота (сеть недоступна), сверьте вручную.`;
  card.append(note);

  if (!snapshot.verified) {
    const warn = document.createElement('p');
    warn.className = 'warn';
    warn.textContent = 'Организация не верифицирована на dobro.ru — аттестация недоступна.';
    card.append(warn);
  }
}

function canSend(): boolean {
  if (!snapshot?.verified) return false;
  if (!wallet || !owner) return false;
  if (wallet.account.chain !== '-239') return false;
  return sameAddress(wallet.account.address, owner);
}

function renderWallet(): void {
  const box = $('wallet');
  const send = $('send') as HTMLButtonElement;

  if (!wallet) {
    box.className = 'hint';
    box.textContent = 'Кошелёк не подключён. Подключите кошелёк owner DAO.';
    send.disabled = true;
    return;
  }

  if (wallet.account.chain !== '-239') {
    box.className = 'hint err';
    box.textContent = 'Подключён тестнет-кошелёк. Нужен mainnet.';
    send.disabled = true;
    return;
  }

  if (!sameAddress(wallet.account.address, owner)) {
    box.className = 'hint err';
    box.textContent = `Кошелёк ${shortAddress(wallet.account.address)} не является owner DAO (${shortAddress(owner ?? '—')}).`;
    send.disabled = true;
    return;
  }

  box.className = 'hint ok';
  box.textContent = `Owner DAO подтверждён: ${shortAddress(wallet.account.address)}`;
  send.disabled = false;
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

async function refreshOwner(): Promise<void> {
  if (!snapshot) return;
  const live = await fetchLiveOwner(snapshot.dao);
  if (!live) return;
  ownerIsLive = true;
  owner = live;
  renderOrg();
  renderWallet();
}

function updatePreview(): void {
  const hours = normalizeHours(($('hours') as HTMLInputElement).value);
  $('preview').textContent =
    hours == null ? 'BLG к выплате: —' : `BLG к выплате: ${claimAmount(hours)} (за целые часы)`;
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  if (!snapshot || !tonConnect || !wallet) {
    setStatus('Сначала подключите кошелёк owner DAO.', 'err');
    return;
  }
  if (!canSend()) {
    setStatus('Кошелёк не прошёл проверку owner DAO.', 'err');
    return;
  }

  const volunteerId = Number(($('volunteer') as HTMLInputElement).value);
  const period = ($('period') as HTMLInputElement).value;
  const hours = normalizeHours(($('hours') as HTMLInputElement).value);
  const docPrefix = snapshot.doc?.sha256.slice(0, 16);

  if (!Number.isInteger(volunteerId) || volunteerId <= 0) {
    setStatus('ID волонтёра должен быть положительным целым.', 'err');
    return;
  }
  if (!docPrefix) {
    setStatus('В снапшоте нет отпечатка документа — аттестация невозможна.', 'err');
    return;
  }

  let comment: string;
  try {
    comment = encodeAttestation({
      version: 1,
      orgId: ORG_ID,
      volunteerId,
      period,
      hours: hours ?? 0,
      docSha256Prefix: docPrefix,
    });
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
          address: wallet.account.address,
          amount: SELF_TX_AMOUNT,
          payload: textCommentPayload(comment),
        },
      ],
    });

    localStorage.setItem(
      'dobro:lastAttestation',
      JSON.stringify({ comment, wallet: wallet.account.address, at: new Date().toISOString() }),
    );

    const status = setStatus('Аттестация отправлена в TON. ', 'ok');
    const code = document.createElement('code');
    code.textContent = comment;
    status.append(code);

    const link = document.createElement('a');
    link.href = `https://tonviewer.com/${wallet.account.address}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
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
    send.disabled = !canSend();
  }
}

async function start(): Promise<void> {
  window.addEventListener('error', (event) => {
    setStatus(`JS: ${event.message}`, 'err');
  });
  window.addEventListener('unhandledrejection', (event) => {
    setStatus(`JS: ${String(event.reason)}`, 'err');
  });

  setStatus('Загрузка снапшота…');
  try {
    snapshot = await loadSnapshot();
  } catch (err) {
    setStatus(`Ошибка: ${err instanceof Error ? err.message : String(err)}`, 'err');
    return;
  }

  owner = snapshot.daoOwner;
  renderOrg();
  initTonConnect();
  renderWallet();

  const period = $('period') as HTMLInputElement;
  if (!period.value) period.value = new Date().toISOString().slice(0, 7);

  ($('hours') as HTMLInputElement).addEventListener('input', updatePreview);
  ($('form') as HTMLFormElement).addEventListener('submit', (event) => {
    void submit(event);
  });
  updatePreview();
  setStatus('Снапшот загружен. Подключите кошелёк owner DAO.');

  void refreshOwner();
}

void start();
