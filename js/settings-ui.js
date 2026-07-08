// 設定タブの UI 配線（測位パラメータ・地図種別・軌跡 ON/OFF）。
// settings オブジェクトを直接書き換え、IndexedDB(settings) へ永続化する。
export function initSettingsUI({ $, settings, storage, mapView, defaults }) {
  // 初期値を各入力へ反映
  $('set-uere').value = settings.uere;
  $('set-autostop').checked = settings.staticAutoStop;
  $('set-minsec').value = settings.staticMinSec;
  $('set-maxsec').value = settings.staticMaxSec;
  $('set-maxepochs').value = settings.staticMaxEpochs;
  $('set-track').checked = settings.trackEnabled;
  document.querySelector(`input[name="maptype"][value="${settings.mapType}"]`).checked = true;

  $('set-uere').addEventListener('change', async (e) => {
    settings.uere = Math.max(1, +e.target.value || defaults.uere);
    await storage.setSetting('uere', settings.uere);
  });
  $('set-autostop').addEventListener('change', async (e) => {
    settings.staticAutoStop = e.target.checked;
    await storage.setSetting('staticAutoStop', settings.staticAutoStop);
  });
  $('set-minsec').addEventListener('change', async (e) => {
    settings.staticMinSec = Math.max(0, +e.target.value >= 0 ? +e.target.value : defaults.staticMinSec);
    await storage.setSetting('staticMinSec', settings.staticMinSec);
  });
  $('set-maxsec').addEventListener('change', async (e) => {
    settings.staticMaxSec = Math.max(0, +e.target.value || 0);
    await storage.setSetting('staticMaxSec', settings.staticMaxSec);
  });
  $('set-maxepochs').addEventListener('change', async (e) => {
    settings.staticMaxEpochs = Math.max(0, +e.target.value || 0);
    await storage.setSetting('staticMaxEpochs', settings.staticMaxEpochs);
  });
  $('set-track').addEventListener('change', async (e) => {
    settings.trackEnabled = e.target.checked;
    mapView.setTrackEnabled(settings.trackEnabled);
    await storage.setSetting('trackEnabled', settings.trackEnabled);
  });
  document.querySelectorAll('input[name="maptype"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      settings.mapType = e.target.value;
      mapView.setBaseLayer(settings.mapType);
      await storage.setSetting('mapType', settings.mapType);
    });
  });
}
