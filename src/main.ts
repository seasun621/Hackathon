import './style.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './game/Game';
import { CONFIG } from './game/config';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App root was not found.');
const appRoot = root;
const touchControlsEnabled = (
  navigator.maxTouchPoints > 0
  && window.matchMedia('(pointer: coarse)').matches
) || (
  import.meta.env.DEV
  && new URLSearchParams(window.location.search).has('touch-preview')
);
document.documentElement.classList.toggle('touch-device', touchControlsEnabled);

root.innerHTML = `
  <div id="speedLines" class="speed-lines"></div>
  <div class="hud">
    <div class="topbar">
      <div>
        <div class="metric-label">SCORE</div>
        <div id="scoreValue" class="score-value">000000</div>
      </div>
      <div class="center-status">
        <div id="stageValue" class="stage-value">STAGE 01</div>
        <div id="timerValue" class="timer">00:00</div>
        <div id="healthMeter" class="health-meter">
          <span id="healthValue">100 / 100</span>
          <div class="health-track"><div id="healthFill" class="health-fill"></div></div>
        </div>
      </div>
      <div class="run-stats">
        <div class="metric-label">LIVE MULTIPLIER</div>
        <strong id="multiplier">1.00 MULTI</strong>
      </div>
    </div>

    <div id="bombMarkers" class="bomb-markers"></div>
    <div id="enemyMarkers" class="enemy-markers"></div>
    <div id="damageNumbers" class="damage-numbers"></div>
    <div id="itemProcLayer" class="item-proc-layer"></div>
    <div id="inventoryBar" class="inventory-bar"></div>
    <div id="anchorReadout" class="anchor-readout">ASSIST ANCHOR</div>
    <div id="combo" class="combo">
      <span class="metric-label">HIT FLOW</span>
      <strong id="comboValue">x0</strong>
    </div>
    <div id="toast" class="toast">
      <span class="toast-badge">BREAK!</span>
      <strong class="toast-points">+000</strong>
      <span class="toast-detail">TARGET BREAK</span>
    </div>
    <div id="hitFlash" class="hit-flash"></div>

    <div class="bottom-hud">
      <div class="meter-stack">
        <div id="staminaMeter" class="meter stamina-meter">
          <div class="meter-label-row">
            <div class="metric-label meter-action-label"><span>DUAL GAS BOOST</span><b>Q →</b><b>SPACE ↑</b></div>
            <strong id="staminaValue">100%</strong>
          </div>
          <div class="meter-track stamina-track"><div id="staminaFill" class="meter-fill stamina-fill"></div></div>
        </div>
      </div>
      <div class="speed-block">
        <div class="metric-label">VELOCITY</div>
        <div class="speed-number"><span id="speedValue">0</span> <small>km/h</small></div>
        <div id="playerStats" class="player-stats">
          <span>SPD <b id="statSpeed">x1.00</b></span>
          <span>GRAV <b id="statGravity">x1.00</b></span>
          <span>DMG IN <b id="statDefense">x1.00</b></span>
          <span>BOOST <b id="statDash">x1.00</b></span>
        </div>
      </div>
      <div id="ropeState" class="rope-state">TETHER // FREE</div>
    </div>
  </div>
  <div id="vignette" class="vignette"></div>

  <div id="touchControls" class="touch-controls" aria-hidden="${String(!touchControlsEnabled)}">
    <div id="touchLookZone" class="touch-look-zone" aria-label="화면 시점 조작 영역"></div>
    <div id="touchJoystick" class="touch-joystick" aria-label="이동 조이스틱">
      <div class="touch-joystick-ring"></div>
      <div id="touchJoystickKnob" class="touch-joystick-knob"></div>
      <span>MOVE</span>
    </div>
    <div class="touch-actions">
      <button id="touchGrapple" class="touch-action grapple" type="button"><small>HOLD</small>TETHER</button>
      <button id="touchFire" class="touch-action fire" type="button"><small>TAP</small>FIRE</button>
      <button id="touchDash" class="touch-action dash" type="button"><small>30%+</small>BOOST</button>
      <button id="touchJump" class="touch-action jump" type="button"><small>30%+</small>JUMP</button>
    </div>
    <button id="touchPause" class="touch-pause" type="button" aria-label="일시정지">Ⅱ</button>
  </div>

  <section id="menuScreen" class="screen">
    <div id="menuPanel" class="panel menu-panel">
      <button id="helpButton" class="help-button" type="button" aria-label="조작법 열기">?</button>
      <div id="menuEyebrow" class="eyebrow">CHOOSE YOUR FLIGHT PROTOCOL</div>
      <h1 id="menuTitle" class="super-logo" aria-label="SUPER SWING">
        <span class="super-logo-word" data-text="SUPER">SUPER</span>
        <span class="super-logo-word swing" data-text="SWING">SWING</span>
        <i class="super-logo-slash"></i>
      </h1>
      <p id="menuTagline" class="tagline">두 개의 비행 규칙. 하나의 완벽한 스윙.</p>
      <div id="modePicker" class="mode-picker" role="radiogroup" aria-label="게임 모드 선택">
        <button class="mode-card" type="button" data-game-mode="time-attack" role="radio" aria-checked="false">
          <span class="mode-number">01</span>
          <span class="mode-icon timer-icon" aria-hidden="true"><i></i></span>
          <span class="mode-kicker">90 SEC BOMB RUSH</span>
          <strong>타임어택</strong>
          <p>전투와 아이템 없이 오직 스윙과 조준으로 90초 동안 최대한 많은 폭탄을 파괴하세요.</p>
          <span class="mode-features"><b>90초 제한</b><b>폭탄 사냥</b><b>순수 스코어</b></span>
          <span class="mode-select">SELECT</span>
        </button>
        <button class="mode-card selected" type="button" data-game-mode="combat" role="radio" aria-checked="true">
          <span class="mode-number">02</span>
          <span class="mode-icon combat-icon" aria-hidden="true"><i></i><i></i></span>
          <span class="mode-kicker">ENDLESS ROGUE FLIGHT</span>
          <strong>전투</strong>
          <p>스코어 게이트를 돌파하고 장비를 강화하며, 점점 거세지는 로봇 군단과 싸우세요.</p>
          <span class="mode-features"><b>10+ 스테이지</b><b>랜덤 장비</b><b>적 증원</b></span>
          <span class="mode-select">SELECTED</span>
        </button>
      </div>
      <div id="helpDialog" class="help-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="help-dialog-head">
          <div><span>FLIGHT MANUAL</span><strong id="helpTitle">조작법</strong></div>
          <button id="helpCloseButton" type="button" aria-label="조작법 닫기">×</button>
        </div>
        <div class="controls">
          <div><kbd>마우스</kbd> 시점 / 조준</div>
          <div><kbd>좌클릭</kbd> 로프 발사 / 당기기</div>
          <div><kbd>우클릭</kbd> 자동 조준 사격</div>
          <div><kbd>WASD</kbd> 공중 보정 / 지상 이동</div>
          <div><kbd>Q</kbd> 전방 가스 부스트</div>
          <div><kbd>SPACE</kbd> 수직 점프 부스트</div>
          <div><kbd>R / ESC</kbd> 재시작 / 일시정지</div>
        </div>
      </div>
      <div class="mobile-control-hint">
        <strong>TOUCH CONTROL</strong>
        <span>왼쪽 스틱 이동 · 오른쪽 화면 드래그 시점 · 전용 버튼으로 로프와 사격</span>
      </div>
      <div class="actions">
        <button id="menuButton" type="button">전투 모드 출격</button>
        <div class="best">PERSONAL BEST<br><strong id="bestScore">0</strong></div>
      </div>
    </div>
  </section>

  <section id="upgradeScreen" class="screen upgrade-screen hidden">
    <div class="upgrade-panel">
      <div class="upgrade-header">
        <div>
          <div class="eyebrow">SCORE GATE CLEARED</div>
          <h2>GEAR ROULETTE</h2>
        </div>
        <div class="upgrade-stage"><span>NEXT</span><strong id="upgradeStageValue">STAGE 02</strong></div>
      </div>
      <p class="upgrade-instruction">세 개의 슬롯 중 하나를 선택해야 비행이 재개됩니다.</p>
      <div id="upgradeReels" class="upgrade-reels rolling">
        ${[0, 1, 2].map((index) => `
          <button class="item-card" type="button" data-offer-index="${index}">
            <div class="item-slot-lines"></div>
            <div class="item-card-top"><span class="item-category">PASSIVE</span><b class="item-status">NEW</b></div>
            <div id="itemPreview${index}" class="item-preview"></div>
            <h3 class="item-name">SCANNING...</h3>
            <div class="item-level">LV.1</div>
            <p class="item-description">GEAR DATA ACQUISITION</p>
            <div class="item-stats"></div>
            <span class="item-replace"></span>
          </button>
        `).join('')}
      </div>
      <div id="upgradeConfirmBar" class="upgrade-confirm-bar hidden">
        <div class="upgrade-confirm-copy">
          <span id="upgradeConfirmEyebrow">GEAR SELECTED</span>
          <strong id="upgradeConfirmName">SELECT A CARD</strong>
          <p id="upgradeConfirmSummary">Confirm the selected upgrade before returning to flight.</p>
        </div>
        <label id="upgradeReplaceWarning" class="upgrade-replace-warning hidden">
          <input id="upgradeReplaceCheck" type="checkbox">
          <span><b>REPLACEMENT WARNING</b><em id="upgradeReplaceText"></em></span>
        </label>
        <button id="upgradeConfirmButton" type="button" disabled>CONFIRM LOADOUT</button>
      </div>
      <div class="upgrade-footer">PASSIVE <i></i> ATTACK <i></i> EQUIPMENT</div>
    </div>
  </section>

  <section id="resultsScreen" class="screen hidden">
    <div class="panel">
      <div id="resultEyebrow" class="eyebrow">COMBAT RUN COMPLETE</div>
      <h2 class="result-logo">SUPER SWING // RESULT</h2>
      <div id="recordLabel" class="eyebrow">BEST 0</div>
      <div class="results-grid">
        <div class="result"><span id="resultScoreLabel" class="metric-label">SCORE</span><strong id="resultScore">0</strong></div>
        <div class="result"><span class="metric-label">ACCURACY</span><strong id="resultAccuracy">0%</strong></div>
        <div class="result"><span class="metric-label">BEST FLOW</span><strong id="resultCombo">x0</strong></div>
        <div class="result"><span class="metric-label">TOP SPEED</span><strong id="resultSpeed">0 km/h</strong></div>
        <div class="result"><span class="metric-label">FALLS</span><strong id="resultFalls">0</strong></div>
        <div class="result"><span class="metric-label">TIME</span><strong id="resultTime">00:00</strong></div>
      </div>
      <div class="result-actions">
        <button id="replayButton" type="button">같은 모드 재도전</button>
        <button id="resultMenuButton" class="secondary-button" type="button">모드 선택</button>
      </div>
    </div>
  </section>
`;

async function boot(): Promise<void> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: CONFIG.gravity, z: 0 });
  new Game(appRoot, world);
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  appRoot.innerHTML = `<section class="screen"><div class="panel"><div class="eyebrow">BOOT ERROR</div><h1>게임을 시작하지 못했습니다.</h1><p>${message}</p></div></section>`;
  console.error(error);
});
