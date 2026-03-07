const CSV_URL = './public/data/pubs.csv';
const FALLBACK_LOCATION = { name: 'Nottingham City Centre', lat: 52.9548, lng: -1.1581 };

const state = {
  pubs: [],
  userLocation: null,
  weather: null,
  map: null,
  markerLayer: null,          // MarkerClusterGroup
  currentView: 'list',
  modalReturnView: 'list',
  userMarker: null,
  userAccuracyCircle: null
};

const els = {
  btnList: document.getElementById('btnList'),
  btnMap: document.getElementById('btnMap'),
  btnNearMe: document.getElementById('btnNearMe'),
  listView: document.getElementById('listView'),
  mapView: document.getElementById('mapView'),
  rowNearMeWrap: document.getElementById('rowNearMeWrap'),
  rowNearMe: document.getElementById('rowNearMe'),
  rowNearMeMeta: document.getElementById('rowNearMeMeta'),
  rowSunniest: document.getElementById('rowSunniest'),
  rowSunniestMeta: document.getElementById('rowSunniestMeta'),
  allList: document.getElementById('allList'),
  allMeta: document.getElementById('allMeta'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalContent: document.getElementById('modalContent'),
  btnClose: document.getElementById('btnClose'),
  weatherBar: document.getElementById('weatherBar'),
  weatherIcon: document.getElementById('weatherIcon'),
  weatherLine: document.getElementById('weatherLine')
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireUi();
  state.pubs = (await loadPubs()).map(enrichPub);
  await refreshWeather(FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lng);
  renderEverything();
  initMap();
  setRowTitles();
  if (location.hash === '#map') setView('map', false);
}

function wireUi() {
  els.btnList.addEventListener('click', () => setView('list'));
  els.btnMap.addEventListener('click', () => setView('map'));
  els.btnNearMe.addEventListener('click', useNearMe);

  els.btnClose.addEventListener('click', () => closeModal(true));
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal(true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal(true);
  });

  window.addEventListener('popstate', () => {
    if (!els.modalOverlay.classList.contains('isHidden')) {
      closeModal(false);
      return;
    }
    if (location.hash === '#map') setView('map', false);
    else setView('list', false);
  });
}

function setView(view, push = true) {
  state.currentView = view;
  const isList = view === 'list';

  els.listView.classList.toggle('isActive', isList);
  els.mapView.classList.toggle('isActive', !isList);
  els.btnList.classList.toggle('isActive', isList);
  els.btnMap.classList.toggle('isActive', !isList);
  els.btnList.setAttribute('aria-selected', String(isList));
  els.btnMap.setAttribute('aria-selected', String(!isList));

  if (!isList && state.map) setTimeout(() => state.map.invalidateSize(), 80);
  if (push) history.pushState({}, '', isList ? '#list' : '#map');
}

async function useNearMe() {
  if (!navigator.geolocation) {
    state.userLocation = { ...FALLBACK_LOCATION, fallback: true };
    renderEverything();
    return;
  }

  els.btnNearMe.textContent = 'Locating…';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      state.userLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        name: 'Your location',
        fallback: false
      };

      els.btnNearMe.textContent = 'Near me';
      await refreshWeather(state.userLocation.lat, state.userLocation.lng);

      renderEverything();
      updateUserLocationMarker();

      if (state.map) state.map.setView([state.userLocation.lat, state.userLocation.lng], 13);
    },
    async () => {
      state.userLocation = { ...FALLBACK_LOCATION, fallback: true };
      els.btnNearMe.textContent = 'Near me';
      await refreshWeather(FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lng);

      renderEverything();
      clearUserLocationMarker();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
}

/* ---------------- CSV ---------------- */

async function loadPubs() {
  const res = await fetch(CSV_URL);
  const text = await res.text();
  return parseCsv(text).map(normalizeRow).filter(isValidPubRow);
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  let headers = null;
  const rows = [];
  for (const line of lines) {
    const cols = splitCsvLine(line);
    if (!headers) {
      headers = cols.map(v => String(v || '').trim());
      continue;
    }
    const obj = {};
    headers.forEach((h, i) => { obj[h] = String(cols[i] ?? '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeRow(row) {
  const pick = (...keys) => {
    for (const k of keys) {
      if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return '';
  };

  return {
    id: pick('id'),
    name: pick('name'),
    address: pick('address'),
    lat: parseFloat(pick('lat')),
    lng: parseFloat(pick('lng')),
    spotA: pick('spot_a', 'Spot_a'),
    baseDate: pick('base_date'),
    spotAStart: pick('spot_a_sun_start'),
    spotAEnd: pick('spot_a_sun_end'),
    spotB: pick('spot_b'),
    spotBStart: pick('spot_b_sun_start'),
    spotBEnd: pick('spot_b_sun_end'),
    imageUrl: pick('image_url'),
    notes: pick('notes')
  };
}

function isValidPubRow(pub) {
  return !!(pub.id && pub.name && Number.isFinite(pub.lat) && Number.isFinite(pub.lng) &&
            pub.spotA && pub.baseDate && pub.spotAStart && pub.spotAEnd);
}

/* ---------------- Sun shift ---------------- */

function enrichPub(pub) {
  const now = new Date();
  const today = formatDate(now);

  const aToday = shiftWindow(pub.lat, pub.lng, pub.baseDate, pub.spotAStart, pub.spotAEnd, today);
  const bToday = (pub.spotB && pub.spotBStart && pub.spotBEnd)
    ? shiftWindow(pub.lat, pub.lng, pub.baseDate, pub.spotBStart, pub.spotBEnd, today)
    : null;

  const best = chooseBestWindow(aToday, bToday, now);

  const distanceKm = state.userLocation
    ? haversineKm(state.userLocation.lat, state.userLocation.lng, pub.lat, pub.lng)
    : null;

  return { ...pub, spotAToday: aToday, spotBToday: bToday, bestNow: best, distanceKm };
}

function reEnrichAll() {
  state.pubs = state.pubs.map(enrichPub);
}

function shiftWindow(lat, lng, baseDateStr, startHHMM, endHHMM, targetDateStr) {
  const baseDate = parseISODate(baseDateStr);
  const targetDate = parseISODate(targetDateStr);

  const baseSolar = getSolarTimesLocal(lat, lng, baseDate);
  const targetSolar = getSolarTimesLocal(lat, lng, targetDate);

  if (!baseSolar || !targetSolar) {
    return {
      start: minutesToLocalDate(targetDate, hhmmToMinutes(startHHMM)),
      end: minutesToLocalDate(targetDate, hhmmToMinutes(endHHMM))
    };
  }

  const baseStartMin = hhmmToMinutes(startHHMM);
  const baseEndMin = hhmmToMinutes(endHHMM);

  const targetStartMin = mapSolarRelative(baseStartMin, baseSolar, targetSolar);
  const targetEndMin = mapSolarRelative(baseEndMin, baseSolar, targetSolar);

  return {
    start: minutesToLocalDate(targetDate, targetStartMin),
    end: minutesToLocalDate(targetDate, targetEndMin)
  };
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToLocalDate(dateObj, minutes) {
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function mapSolarRelative(obsMinutes, baseSolar, targetSolar) {
  if (obsMinutes <= baseSolar.noon) {
    const frac = safeFraction(obsMinutes, baseSolar.sunrise, baseSolar.noon);
    return targetSolar.sunrise + frac * (targetSolar.noon - targetSolar.sunrise);
  }
  const frac = safeFraction(obsMinutes, baseSolar.noon, baseSolar.sunset);
  return targetSolar.noon + frac * (targetSolar.sunset - targetSolar.noon);
}

function safeFraction(value, min, max) {
  if (max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

function getSolarTimesLocal(lat, lng, dateObj) {
  const dayNum = dayOfYear(dateObj);
  const gamma = (2 * Math.PI / 365) * (dayNum - 1);

  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latRad = deg2rad(lat);
  const zenith = deg2rad(90.833);

  const cosH =
    (Math.cos(zenith) / (Math.cos(latRad) * Math.cos(decl))) -
    Math.tan(latRad) * Math.tan(decl);

  if (cosH < -1 || cosH > 1) return null;

  const hourAngleDeg = rad2deg(Math.acos(cosH));
  const tzHours = -dateObj.getTimezoneOffset() / 60;

  const solarNoon = 720 - (4 * lng) - eqTime + (tzHours * 60);
  const sunrise = solarNoon - (hourAngleDeg * 4);
  const sunset = solarNoon + (hourAngleDeg * 4);

  return { sunrise, noon: solarNoon, sunset };
}

function dayOfYear(dateObj) {
  const start = new Date(dateObj.getFullYear(), 0, 0);
  const diff = dateObj - start;
  return Math.floor(diff / 86400000);
}

/* ---------------- Weather tone + display ---------------- */

function getWeatherTone() {
  if (!state.weather) return 'cloudy';
  const mood = weatherMood(state.weather.code, state.weather.rain);
  return mood.className; // sunny | cloudy | rainy
}

function getDisplayStatus(pub) {
  const tone = getWeatherTone();
  const baseState = pub.bestNow.state; // sunny/shade/none

  let top = 'No more sun today';
  let line = pub.bestNow.line;
  let cls = 'statusNone';

  // Pin colours
  let pinClass = 'pinGrey';

  if (baseState === 'sunny') {
    if (tone === 'sunny') {
      top = 'Sunny now';
      cls = 'statusSunBright';
      pinClass = 'pinSunny';
    } else if (tone === 'cloudy') {
      // label tweak: keep mustard tone but clarify meaning
      top = 'Sun window now';
      cls = 'statusSunMuted';
      pinClass = 'pinCloudy';
    } else {
      top = 'Not sunny now';
      cls = 'statusSunRainy';
      pinClass = 'pinGrey';
    }
  } else if (baseState === 'shade') {
    if (tone === 'rainy') {
      top = 'Rainy now';
      cls = 'statusSunRainy';
    } else if (tone === 'cloudy') {
      top = 'Cloudy now';
      cls = 'statusShade';
    } else {
      top = 'Not sunny now';
      cls = 'statusShade';
    }
    pinClass = 'pinGrey';
  } else {
    top = 'No more sun today';
    cls = 'statusNone';
    pinClass = 'pinGrey';
  }

  return { top, line, cls, pinClass, tone };
}

function buildSpotStateWeatherAware(windowObj, now) {
  const tone = getWeatherTone();
  if (!windowObj) return { status: 'Sun time unavailable', line: '', badge: 'Unavailable' };

  const inWindow = now >= windowObj.start && now <= windowObj.end;
  const upcoming = now < windowObj.start;

  if (inWindow) {
    if (tone === 'sunny') return { status: 'Sunny now', line: `Sun until ${fmtTime(windowObj.end)}`, badge: 'Best now' };
    if (tone === 'cloudy') return { status: 'Sun window now', line: `Sun until ${fmtTime(windowObj.end)}`, badge: 'Best now' };
    return { status: 'Not sunny now', line: `Sun until ${fmtTime(windowObj.end)}`, badge: 'Best now' };
  }

  if (upcoming) {
    if (tone === 'rainy') return { status: 'Rainy now', line: `Sun from ${fmtTime(windowObj.start)}`, badge: 'Later today' };
    if (tone === 'cloudy') return { status: 'Cloudy now', line: `Sun from ${fmtTime(windowObj.start)}`, badge: 'Later today' };
    return { status: 'Not sunny now', line: `Sun from ${fmtTime(windowObj.start)}`, badge: 'Later today' };
  }

  return { status: 'Finished today', line: 'No more sun today', badge: 'Finished today' };
}

/* ---------------- Window selection ---------------- */

function getWindows(pub) {
  const out = [];
  if (pub.spotAToday) out.push(pub.spotAToday);
  if (pub.spotBToday) out.push(pub.spotBToday);
  return out;
}

function getWindowStats(pub, now) {
  const windows = getWindows(pub).filter(w => w && w.end > w.start);
  const remaining = windows.filter(w => w.end > now);
  const active = remaining.find(w => now >= w.start && now <= w.end) || null;
  const next = remaining.filter(w => now < w.start).sort((a,b)=>a.start-b.start)[0] || null;
  const latestRemainingWindow = remaining.sort((a,b)=>b.end-a.end)[0] || null;
  const latestRemainingEnd = latestRemainingWindow ? latestRemainingWindow.end : null;
  return { activeWindow: active, nextWindow: next, latestRemainingEnd, latestRemainingWindow };
}

function chooseBestWindow(a, b, now) {
  const candidates = [a, b].filter(Boolean);
  if (!candidates.length) return { state: 'none', line: 'Sun time unavailable', window: null };

  const active = candidates.find(w => now >= w.start && now <= w.end);
  if (active) return { state: 'sunny', line: `Sun until ${fmtTime(active.end)}`, window: active };

  const upcoming = candidates.filter(w => now < w.start).sort((x, y) => x.start - y.start)[0];
  if (upcoming) return { state: 'shade', line: `Sun from ${fmtTime(upcoming.start)}`, window: upcoming };

  return { state: 'none', line: 'No more sun today', window: null };
}

/* ---------------- Rendering ---------------- */

function renderEverything() {
  reEnrichAll();
  setRowTitles();
  renderSunniest
