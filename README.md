# NEON TETHER

절차 생성되는 로우폴리 도심에서 로프 스윙과 타이밍 사격을 결합한 1인칭 3D 스코어 어택 프로토타입입니다. 별도의 3D 모델 없이 Three.js 기본 도형과 Rapier 물리로 제작했습니다.

## 웹에서 플레이

[GitHub Pages에서 NEON TETHER 실행하기](https://seasun621.github.io/Hackathon/)

화면을 클릭한 뒤 `출격` 버튼을 누르면 시작됩니다. 데스크톱 브라우저의 키보드와 마우스 조작을 기준으로 제작되었습니다.

## 조작

- 마우스 이동: 시점 및 조준
- 왼쪽 버튼 누르기: 보정된 앵커로 로프 발사·교체, 유지하는 동안 로프 당기기
- 왼쪽 버튼 놓기: 로프 해제
- 오른쪽 버튼: 폭탄의 추적 박스가 `FIRE NOW` 상태일 때 자동 보정 사격
- W/A/S/D: 공중 방향 보정, 지상 저속 이동
- Q: 현재 스태미나를 모두 사용해 시선 방향으로 직선 부스트
- Space: 시간 감속
- R: 현재 판 재시작
- Esc: 일시 정지

폭탄의 조준 표시는 화면 중앙에 고정되지 않고 폭탄의 화면상 위치를 따라갑니다. 플레이어 위치와 시야각을 조절해 확실한 사격선이 확보되면 표시가 붉게 바뀌며, 그 순간 오른쪽 버튼을 누르면 대상에 자동 보정됩니다.

## 로컬 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://127.0.0.1:43127/`을 엽니다.

배포용 빌드는 다음 명령으로 확인할 수 있습니다.

```bash
npm run build
```

## 기술 구성

- TypeScript
- Vite
- Three.js
- Rapier 3D
- GitHub Actions 및 GitHub Pages

개발 범위와 진행 내역은 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md), [PROGRESS.md](./PROGRESS.md)를 참고하세요.
