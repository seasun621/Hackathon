import './style.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './game/Game';
import { CONFIG } from './game/config';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App root was not found.');
const appRoot = root;

root.innerHTML = `
  <div id="speedLines" class="speed-lines"></div>
  <div id="focusFx" class="focus-fx"><span>TIME FRACTURE</span></div>
  <div class="hud">
    <div class="topbar">
      <div>
        <div class="metric-label">SCORE</div>
        <div id="scoreValue" class="score-value">000000</div>
      </div>
      <div id="timerValue" class="timer">90</div>
      <div class="run-stats">
        <div class="metric-label">LIVE MULTIPLIER</div>
        <strong id="multiplier">1.00 MULTI</strong>
      </div>
    </div>

    <div id="bombMarkers" class="bomb-markers"></div>
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
        <div class="meter">
          <div class="metric-label">FOCUS // SPACE</div>
          <div class="meter-track"><div id="focusFill" class="meter-fill"></div></div>
        </div>
        <div id="staminaMeter" class="meter stamina-meter">
          <div class="meter-label-row">
            <div class="metric-label">GAS THRUST // Q</div>
            <strong id="staminaValue">100%</strong>
          </div>
          <div class="meter-track stamina-track"><div id="staminaFill" class="meter-fill stamina-fill"></div></div>
        </div>
      </div>
      <div class="speed-block">
        <div class="metric-label">VELOCITY</div>
        <div class="speed-number"><span id="speedValue">0</span> <small>km/h</small></div>
      </div>
      <div id="ropeState" class="rope-state">TETHER // FREE</div>
    </div>
  </div>
  <div id="vignette" class="vignette"></div>

  <section id="menuScreen" class="screen">
    <div class="panel">
      <div id="menuEyebrow" class="eyebrow">90 SECOND SWING / SHOOT PROTOCOL</div>
      <h1 id="menuTitle" class="logo">NEON<br>TETHER</h1>
      <p id="menuTagline" class="tagline">도시에 매달리고, 흐름을 만들고, 접근하는 폭탄을 잠가 부숴라.</p>
      <div class="controls">
        <div><kbd>마우스</kbd> 시점 / 조준</div>
        <div><kbd>좌클릭</kbd> 로프 / 당기기</div>
        <div><kbd>우클릭</kbd> 폭탄 잠금 사격</div>
        <div><kbd>WASD</kbd> 공중 보정 / 느린 보행</div>
        <div><kbd>Q</kbd> 스태미나 전량 가스 추진</div>
        <div><kbd>SPACE</kbd> 포커스</div>
        <div><kbd>R / ESC</kbd> 재시작 / 일시정지</div>
      </div>
      <div class="actions">
        <button id="menuButton" type="button">출격</button>
        <div class="best">PERSONAL BEST<br><strong id="bestScore">0</strong></div>
      </div>
    </div>
  </section>

  <section id="resultsScreen" class="screen hidden">
    <div class="panel">
      <div class="eyebrow">RUN COMPLETE</div>
      <h2 class="logo">RESULT</h2>
      <div id="recordLabel" class="eyebrow">BEST 0</div>
      <div class="results-grid">
        <div class="result"><span class="metric-label">SCORE</span><strong id="resultScore">0</strong></div>
        <div class="result"><span class="metric-label">ACCURACY</span><strong id="resultAccuracy">0%</strong></div>
        <div class="result"><span class="metric-label">BEST FLOW</span><strong id="resultCombo">x0</strong></div>
        <div class="result"><span class="metric-label">TOP SPEED</span><strong id="resultSpeed">0 km/h</strong></div>
        <div class="result"><span class="metric-label">FALLS</span><strong id="resultFalls">0</strong></div>
        <div class="result"><span class="metric-label">TIME</span><strong>90 s</strong></div>
      </div>
      <button id="replayButton" type="button">다시 출격</button>
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
