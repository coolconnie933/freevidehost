(() => {
  "use strict";

  const VIDKING_ORIGIN = "https://www.vidking.net";
  const STORAGE_KEYS = {
    history: "local_vidking_history_v1",
    progressPrefix: "local_vidking_progress_v1_",
    settings: "local_vidking_settings_v1"
  };
  const LEGACY_STORAGE_KEYS = {
    history: "local_vidking_history_v2",
    progressPrefix: "local_vidking_progress_v2_",
    settings: "local_vidking_settings_v2"
  };
  const EPISODES_DEFAULT_MESSAGE = "Load a TV programme to browse seasons and episodes.";
  const EPISODES_UNAVAILABLE_MESSAGE = "TMDB-powered season browsing is unavailable right now.";

  const elements = {
    form: document.querySelector("#playerForm"),
    playerTab: document.querySelector("#playerTab"),
    episodesTab: document.querySelector("#episodesTab"),
    playerPanel: document.querySelector("#playerPanel"),
    episodesPanel: document.querySelector("#episodesPanel"),
    tmdbModeStatusSection: document.querySelector("#tmdbModeStatusSection"),
    tmdbModeStatus: document.querySelector("#tmdbModeStatus"),
    tmdbSearchSection: document.querySelector("#tmdbSearchSection"),
    manualTmdbSection: document.querySelector("#manualTmdbSection"),
    selectedContentSection: document.querySelector("#selectedContentSection"),
    selectedContentDivider: document.querySelector("#selectedContentDivider"),
    searchInput: document.querySelector("#searchInput"),
    searchButton: document.querySelector("#searchButton"),
    searchStatus: document.querySelector("#searchStatus"),
    searchResults: document.querySelector("#searchResults"),
    seasonSelect: document.querySelector("#seasonSelect"),
    episodesMeta: document.querySelector("#episodesMeta"),
    episodesStatus: document.querySelector("#episodesStatus"),
    episodeList: document.querySelector("#episodeList"),
    mediaTypes: [...document.querySelectorAll('input[name="mediaType"]')],
    title: document.querySelector("#titleInput"),
    tmdb: document.querySelector("#tmdbInput"),
    season: document.querySelector("#seasonInput"),
    episode: document.querySelector("#episodeInput"),
    tvFields: document.querySelector("#tvFields"),
    tvOptions: document.querySelector("#tvOptions"),
    colorPicker: document.querySelector("#colorPicker"),
    colorInput: document.querySelector("#colorInput"),
    autoplay: document.querySelector("#autoplayInput"),
    resume: document.querySelector("#resumeInput"),
    episodeSelector: document.querySelector("#episodeSelectorInput"),
    nextEpisode: document.querySelector("#nextEpisodeInput"),
    error: document.querySelector("#formError"),
    iframe: document.querySelector("#player"),
    emptyState: document.querySelector("#emptyState"),
    heading: document.querySelector("#playerHeading"),
    copyUrl: document.querySelector("#copyUrlButton"),
    open: document.querySelector("#openButton"),
    connectionText: document.querySelector("#connectionStatusText"),
    progressArea: document.querySelector("#progressArea"),
    progressTrack: document.querySelector(".progress-track"),
    progressFill: document.querySelector("#progressFill"),
    eventStatus: document.querySelector("#eventStatus"),
    timeStatus: document.querySelector("#timeStatus"),
    historyList: document.querySelector("#historyList"),
    clearHistory: document.querySelector("#clearHistoryButton")
  };

  const episodeCache = {
    shows: new Map(),
    seasons: new Map()
  };
  const episodeRequests = {
    showController: null,
    seasonController: null,
    showRequestId: 0,
    seasonRequestId: 0
  };
  const episodesView = {
    tmdbId: "",
    seasonNumber: null,
    showName: ""
  };

  let currentItem = null;
  let currentUrl = "";
  let searchController = null;
  let tmdbTokenConfigured = false;
  let activeControlsTab = "player";
  let episodesTabEnabled = false;

  function getMediaType() {
    return elements.mediaTypes.find(input => input.checked)?.value || "movie";
  }

  function setMediaType(type) {
    const input = elements.mediaTypes.find(item => item.value === type);
    if (input) input.checked = true;

    const isTv = type === "tv";
    elements.tvFields.hidden = !isTv;
    elements.tvOptions.hidden = !isTv;
  }

  function sanitizeHex(value) {
    return String(value).replace(/[^a-fA-F0-9]/g, "").slice(0, 6).toLowerCase();
  }

  function numericValue(value, min, max) {
    const number = Number.parseInt(String(value), 10);
    if (!Number.isInteger(number)) return null;
    if (number < min || number > max) return null;
    return number;
  }

  function contentKey(item) {
    if (item.type === "movie") return `movie_${item.tmdbId}`;
    return `tv_${item.tmdbId}_${item.season}_${item.episode}`;
  }

  function progressStorageKey(item, prefix = STORAGE_KEYS.progressPrefix) {
    return prefix + contentKey(item);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function readJsonAny(keys, fallback) {
    for (const key of keys) {
      const value = readJson(key, undefined);
      if (value !== undefined) return value;
    }
    return fallback;
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage may be blocked or full. The player remains usable.
    }
  }

  function getSavedProgress(item) {
    const saved = readJsonAny([
      progressStorageKey(item),
      progressStorageKey(item, LEGACY_STORAGE_KEYS.progressPrefix)
    ], null);
    if (!saved || !Number.isFinite(saved.currentTime) || saved.currentTime <= 0) return null;
    return saved;
  }

  function buildUrl(item, settings) {
    const route = item.type === "movie"
      ? `/embed/movie/${item.tmdbId}`
      : `/embed/tv/${item.tmdbId}/${item.season}/${item.episode}`;

    const url = new URL(route, VIDKING_ORIGIN);
    url.searchParams.set("color", settings.color);
    url.searchParams.set("autoPlay", String(settings.autoPlay));

    if (item.type === "tv") {
      url.searchParams.set("nextEpisode", String(settings.nextEpisode));
      url.searchParams.set("episodeSelector", String(settings.episodeSelector));
    }

    const saved = settings.resume ? getSavedProgress(item) : null;
    if (saved && saved.currentTime < (saved.duration || Infinity) - 30) {
      url.searchParams.set("progress", String(Math.floor(saved.currentTime)));
    }

    return url.toString();
  }

  function displayTitle(item) {
    if (item.title) return item.title;
    if (item.type === "tv") return `TV ${item.tmdbId} - S${item.season} E${item.episode}`;
    return `Movie ${item.tmdbId}`;
  }

  function formatSeconds(value) {
    if (!Number.isFinite(value) || value < 0) return "00:00";

    const total = Math.floor(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = number => String(number).padStart(2, "0");

    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  function eventLabel(eventName) {
    const labels = {
      timeupdate: "Playing",
      play: "Playing",
      pause: "Paused",
      ended: "Finished",
      seeked: "Position changed"
    };
    return labels[eventName] || "Player active";
  }

  function accentSoftFromHex(color) {
    const red = Number.parseInt(color.slice(0, 2), 16);
    const green = Number.parseInt(color.slice(2, 4), 16);
    const blue = Number.parseInt(color.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, 0.18)`;
  }

  function showError(message) {
    elements.error.textContent = message;
    elements.error.hidden = false;
  }

  function clearError() {
    elements.error.textContent = "";
    elements.error.hidden = true;
  }

  function setSearchStatus(message, isError = false) {
    elements.searchStatus.textContent = message;
    elements.searchStatus.classList.toggle("error", isError);
  }

  function setTmdbModeStatus(message, isError = false) {
    elements.tmdbModeStatus.textContent = message;
    elements.tmdbModeStatus.classList.toggle("error", isError);
    elements.tmdbModeStatusSection.hidden = !message;
  }

  function setConnectionStatus(message) {
    elements.connectionText.textContent = message;
  }

  function refreshConnectionStatus() {
    if (!navigator.onLine) {
      setConnectionStatus("Offline");
      return;
    }
    if (currentUrl) {
      setConnectionStatus("Loaded");
      return;
    }
    if (!tmdbTokenConfigured) {
      setConnectionStatus("Search unavailable");
      return;
    }
    setConnectionStatus("Ready");
  }

  function updateTmdbModeUi() {
    elements.manualTmdbSection.hidden = tmdbTokenConfigured;
    elements.tmdbSearchSection.hidden = !tmdbTokenConfigured;
    elements.selectedContentDivider.hidden = !tmdbTokenConfigured;

    if (tmdbTokenConfigured) {
      setTmdbModeStatus("", false);
      return;
    }

    elements.searchResults.hidden = true;
    setSearchStatus("");
    setTmdbModeStatus("TMDB title search is unavailable on this deployment.", false);
  }

  function saveSettings() {
    writeJson(STORAGE_KEYS.settings, {
      mediaType: getMediaType(),
      color: sanitizeHex(elements.colorInput.value) || "e50914",
      autoPlay: elements.autoplay.checked,
      resume: elements.resume.checked,
      episodeSelector: elements.episodeSelector.checked,
      nextEpisode: elements.nextEpisode.checked
    });
  }

  function restoreSettings() {
    const settings = readJsonAny([STORAGE_KEYS.settings, LEGACY_STORAGE_KEYS.settings], null);
    if (!settings) {
      setMediaType("movie");
      updateAccent("e50914");
      return;
    }

    setMediaType(settings.mediaType === "tv" ? "tv" : "movie");
    const color = /^[a-fA-F0-9]{6}$/.test(settings.color || "") ? settings.color : "e50914";
    elements.colorInput.value = color;
    elements.colorPicker.value = `#${color}`;
    elements.autoplay.checked = Boolean(settings.autoPlay);
    elements.resume.checked = settings.resume !== false;
    elements.episodeSelector.checked = settings.episodeSelector !== false;
    elements.nextEpisode.checked = settings.nextEpisode !== false;
    updateAccent(color);
  }

  function updateAccent(color) {
    const valid = /^[a-fA-F0-9]{6}$/.test(color) ? color : "e50914";
    document.documentElement.style.setProperty("--accent", `#${valid}`);
    document.documentElement.style.setProperty("--accent-soft", accentSoftFromHex(valid));
  }

  function getHistory() {
    const history = readJsonAny([STORAGE_KEYS.history, LEGACY_STORAGE_KEYS.history], []);
    return Array.isArray(history) ? history : [];
  }

  function addToHistory(item, progressData = null) {
    const existing = getHistory();
    const previous = existing.find(entry => contentKey(entry) === contentKey(item));
    const history = existing.filter(entry => contentKey(entry) !== contentKey(item));
    const merged = {
      ...previous,
      ...item,
      lastPlayed: Date.now(),
      progress: progressData?.progress ?? previous?.progress ?? 0,
      currentTime: progressData?.currentTime ?? previous?.currentTime ?? 0,
      duration: progressData?.duration ?? previous?.duration ?? 0
    };

    history.unshift(merged);
    writeJson(STORAGE_KEYS.history, history.slice(0, 12));
    renderHistory();
  }

  function renderHistory() {
    const history = getHistory();
    elements.historyList.replaceChildren();

    if (!history.length) {
      const empty = document.createElement("p");
      empty.className = "muted-copy";
      empty.textContent = "No viewing history has been saved on this browser.";
      elements.historyList.append(empty);
      return;
    }

    history.forEach(item => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-item";

      const copy = document.createElement("span");
      copy.className = "history-copy";

      const title = document.createElement("span");
      title.className = "history-title";
      title.textContent = displayTitle(item);

      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = item.type === "tv"
        ? `TMDB ${item.tmdbId} - Season ${item.season}, Episode ${item.episode}`
        : `TMDB ${item.tmdbId} - Movie`;

      const progress = document.createElement("span");
      progress.className = "history-progress";
      const percentage = Math.max(0, Math.min(100, Number(item.progress) || 0));
      progress.textContent = percentage > 0 ? `${Math.round(percentage)}% watched` : "Load";

      copy.append(title, meta);
      button.append(copy, progress);
      button.addEventListener("click", () => loadHistoryItem(item));
      elements.historyList.append(button);
    });
  }

  function submitPlayerForm() {
    if (typeof elements.form.requestSubmit === "function") {
      elements.form.requestSubmit();
      return;
    }

    elements.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  function loadHistoryItem(item) {
    setMediaType(item.type);
    elements.title.value = item.title || "";
    elements.tmdb.value = item.tmdbId;

    if (item.type === "tv") {
      elements.season.value = item.season;
      elements.episode.value = item.episode;
    }

    submitPlayerForm();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetProgressDisplay(saved = null) {
    const progress = saved?.progress || 0;
    elements.progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    elements.eventStatus.textContent = saved ? "Saved position loaded" : "Waiting for playback";
    elements.timeStatus.textContent = saved
      ? `${formatSeconds(saved.currentTime)} / ${formatSeconds(saved.duration)}`
      : "00:00 / 00:00";
  }

  function currentTvContext() {
    if (!currentItem || currentItem.type !== "tv") return null;

    const tmdbId = String(currentItem.tmdbId).trim();
    const season = numericValue(currentItem.season, 0, 999);
    const episode = numericValue(currentItem.episode, 1, 9999);
    if (!/^\d+$/.test(tmdbId) || season === null || episode === null) return null;

    return {
      tmdbId,
      season,
      episode,
      title: currentItem.title || ""
    };
  }

  function availableTabs() {
    return [elements.playerTab, elements.episodesTab].filter(tab => !tab.hidden && !tab.disabled);
  }

  function activateControlsTab(tabName, options = {}) {
    const target = tabName === "episodes" && episodesTabEnabled ? "episodes" : "player";
    activeControlsTab = target;

    const playerSelected = target === "player";
    elements.playerTab.setAttribute("aria-selected", String(playerSelected));
    elements.playerTab.tabIndex = playerSelected ? 0 : -1;
    elements.playerPanel.hidden = !playerSelected;

    const episodesSelected = target === "episodes" && episodesTabEnabled;
    elements.episodesTab.setAttribute("aria-selected", String(episodesSelected));
    elements.episodesTab.tabIndex = episodesSelected ? 0 : -1;
    elements.episodesPanel.hidden = !episodesSelected;

    if (options.focusTab) {
      (playerSelected ? elements.playerTab : elements.episodesTab).focus();
    }
  }

  function setEpisodesTabAvailability(enabled) {
    episodesTabEnabled = enabled;
    elements.episodesTab.disabled = !enabled;
    elements.episodesTab.setAttribute("aria-disabled", String(!enabled));

    if (!enabled && activeControlsTab === "episodes") {
      activeControlsTab = "player";
    }

    activateControlsTab(activeControlsTab);
  }

  function handleTabKeydown(event) {
    const tabs = availableTabs();
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex === -1) return;

    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      activateControlsTab(tabs[nextIndex].dataset.tab, { focusTab: true });
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateControlsTab(event.currentTarget.dataset.tab, { focusTab: true });
    }
  }

  function setEpisodesMeta(message) {
    elements.episodesMeta.textContent = message;
  }

  function setSeasonSelectPlaceholder(label) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = label;
    elements.seasonSelect.replaceChildren(option);
    elements.seasonSelect.value = "";
    elements.seasonSelect.disabled = true;
  }

  function setEpisodesStatus(message, variant = "empty") {
    elements.episodesStatus.textContent = message;
    elements.episodesStatus.className = `episodes-status episodes-state-${variant}`;
    elements.episodesStatus.hidden = false;
    elements.episodeList.hidden = true;
    elements.episodeList.replaceChildren();
  }

  function resetEpisodesUi(message = EPISODES_DEFAULT_MESSAGE) {
    setEpisodesMeta(message);
    setSeasonSelectPlaceholder("Choose a season");
    setEpisodesStatus(message, "empty");
  }

  function abortEpisodeRequests() {
    episodeRequests.showController?.abort();
    episodeRequests.seasonController?.abort();
    episodeRequests.showController = null;
    episodeRequests.seasonController = null;
  }

  function resetEpisodesForMovie() {
    abortEpisodeRequests();
    episodesView.tmdbId = "";
    episodesView.seasonNumber = null;
    episodesView.showName = "";
    resetEpisodesUi(EPISODES_DEFAULT_MESSAGE);
    setEpisodesTabAvailability(false);
  }

  function resetEpisodesForMissingToken() {
    abortEpisodeRequests();
    episodesView.tmdbId = "";
    episodesView.seasonNumber = null;
    episodesView.showName = "";
    resetEpisodesUi(EPISODES_UNAVAILABLE_MESSAGE);
    setEpisodesTabAvailability(false);
  }

  function formatSeasonLabel(seasonNumber, name = "") {
    const baseLabel = seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
    const cleanName = String(name || "").trim();
    if (!cleanName || cleanName.toLowerCase() === baseLabel.toLowerCase()) {
      return baseLabel;
    }
    return `${baseLabel} - ${cleanName}`;
  }

  function formatEpisodeMeta(episode) {
    const parts = [];
    if (episode.airDate) parts.push(episode.airDate);
    if (Number.isFinite(episode.runtime) && episode.runtime > 0) parts.push(`${episode.runtime} min`);
    if (Number.isFinite(episode.voteAverage) && episode.voteAverage > 0) {
      parts.push(`Rating ${episode.voteAverage.toFixed(1)}`);
    }
    return parts.join(" - ");
  }

  function buildEpisodeDisplayTitle(showName, seasonNumber, episodeNumber, episodeName) {
    const parts = [
      showName || `TV ${elements.tmdb.value.trim()}`,
      `S${seasonNumber} E${episodeNumber}`
    ];
    if (episodeName) parts.push(episodeName);
    return parts.join(" - ");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed with status ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function isTmdbTokenUnavailableError(error) {
    return [401, 403, 503].includes(Number(error?.status));
  }

  async function getTvDetails(tmdbId, signal) {
    const key = String(tmdbId);
    if (episodeCache.shows.has(key)) {
      return episodeCache.shows.get(key);
    }

    const payload = await fetchJson(`/api/tmdb/tv/${encodeURIComponent(key)}`, { signal });
    episodeCache.shows.set(key, payload);
    return payload;
  }

  async function getSeasonDetails(tmdbId, seasonNumber, signal) {
    const key = `${tmdbId}:${seasonNumber}`;
    if (episodeCache.seasons.has(key)) {
      return episodeCache.seasons.get(key);
    }

    const payload = await fetchJson(
      `/api/tmdb/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(String(seasonNumber))}`,
      { signal }
    );
    episodeCache.seasons.set(key, payload);
    return payload;
  }

  function updateEpisodeSelectionHighlight() {
    const tvContext = currentTvContext();
    const selectedSeason = numericValue(elements.seasonSelect.value, 0, 999);
    const episodeCards = elements.episodeList.querySelectorAll(".episode-card");

    episodeCards.forEach(card => {
      const cardSeason = numericValue(card.dataset.season, 0, 999);
      const cardEpisode = numericValue(card.dataset.episode, 1, 9999);
      const isSelected = Boolean(
        tvContext &&
        episodesView.tmdbId === tvContext.tmdbId &&
        selectedSeason !== null &&
        tvContext.season === selectedSeason &&
        cardSeason === tvContext.season &&
        cardEpisode === tvContext.episode
      );
      card.classList.toggle("is-selected", isSelected);
      card.setAttribute("aria-selected", String(isSelected));
    });
  }

  function populateSeasonSelect(showDetails, selectedSeason) {
    const seasons = Array.isArray(showDetails.seasons) ? showDetails.seasons : [];
    if (!seasons.length) {
      setSeasonSelectPlaceholder("No seasons available");
      return null;
    }

    elements.seasonSelect.replaceChildren();
    seasons.forEach(season => {
      const option = document.createElement("option");
      option.value = String(season.seasonNumber);
      option.textContent = formatSeasonLabel(season.seasonNumber, season.name);
      elements.seasonSelect.append(option);
    });

    const hasSelectedSeason = seasons.some(season => season.seasonNumber === selectedSeason);
    const seasonToUse = hasSelectedSeason ? selectedSeason : seasons[0].seasonNumber;
    elements.seasonSelect.value = String(seasonToUse);
    elements.seasonSelect.disabled = false;
    episodesView.seasonNumber = seasonToUse;
    return seasonToUse;
  }

  function loadEpisodeFromList(seasonNumber, episode) {
    const tvContext = currentTvContext();
    if (!tvContext) return;

    const showName = episodesView.showName || tvContext.title || `TV ${tvContext.tmdbId}`;
    elements.tmdb.value = tvContext.tmdbId;
    elements.season.value = seasonNumber;
    elements.episode.value = episode.episodeNumber;
    elements.title.value = buildEpisodeDisplayTitle(showName, seasonNumber, episode.episodeNumber, episode.name);
    setSearchStatus(`Selected ${elements.title.value}. Loading player...`);
    clearError();
    submitPlayerForm();
    activateControlsTab("player");
  }

  function renderEpisodeList(seasonDetails, seasonNumber) {
    const episodes = Array.isArray(seasonDetails.episodes) ? seasonDetails.episodes : [];
    elements.episodeList.replaceChildren();

    if (!episodes.length) {
      setEpisodesStatus("No episodes were returned for this season.", "empty");
      return;
    }

    episodes.forEach(episode => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "episode-card";
      button.dataset.season = String(seasonNumber);
      button.dataset.episode = String(episode.episodeNumber);
      button.setAttribute("aria-selected", "false");

      if (episode.stillUrl) {
        const image = document.createElement("img");
        image.className = "episode-still";
        image.src = episode.stillUrl;
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        button.append(image);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "episode-still-placeholder";
        placeholder.textContent = "No image";
        button.append(placeholder);
      }

      const copy = document.createElement("span");
      copy.className = "episode-copy";

      const kicker = document.createElement("span");
      kicker.className = "episode-kicker";
      kicker.textContent = `Episode ${episode.episodeNumber}`;

      const title = document.createElement("span");
      title.className = "episode-title";
      title.textContent = episode.name || `Episode ${episode.episodeNumber}`;

      copy.append(kicker, title);

      const meta = formatEpisodeMeta(episode);
      if (meta) {
        const metaLine = document.createElement("span");
        metaLine.className = "episode-meta";
        metaLine.textContent = meta;
        copy.append(metaLine);
      }

      const overview = document.createElement("p");
      overview.className = "episode-overview";
      overview.textContent = episode.overview || "No description available.";
      copy.append(overview);

      button.append(copy);
      button.addEventListener("click", () => loadEpisodeFromList(seasonNumber, episode));
      elements.episodeList.append(button);
    });

    elements.episodesStatus.hidden = true;
    elements.episodeList.hidden = false;
    updateEpisodeSelectionHighlight();
  }

  async function loadSeasonEpisodes(tmdbId, seasonNumber) {
    episodesView.tmdbId = String(tmdbId);
    episodesView.seasonNumber = seasonNumber;
    elements.seasonSelect.value = String(seasonNumber);
    elements.seasonSelect.disabled = true;
    setEpisodesStatus(`Loading ${formatSeasonLabel(seasonNumber)}...`, "loading");

    const requestId = ++episodeRequests.seasonRequestId;
    episodeRequests.seasonController?.abort();
    const controller = new AbortController();
    episodeRequests.seasonController = controller;

    try {
      const seasonDetails = await getSeasonDetails(tmdbId, seasonNumber, controller.signal);
      if (controller.signal.aborted || requestId !== episodeRequests.seasonRequestId) return;
      if (episodesView.tmdbId !== String(tmdbId) || episodesView.seasonNumber !== seasonNumber) return;

      renderEpisodeList(seasonDetails, seasonNumber);
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (isTmdbTokenUnavailableError(error)) {
        handleTmdbTokenUnavailable(
          error instanceof Error ? error.message : "TMDB episode metadata is unavailable right now."
        );
      }
      setEpisodesStatus(
        error instanceof Error ? error.message : "Episode metadata could not be loaded.",
        "error"
      );
    } finally {
      if (episodesView.tmdbId === String(tmdbId) && elements.seasonSelect.value === String(seasonNumber)) {
        elements.seasonSelect.disabled = false;
      }
    }
  }

  async function syncEpisodesForCurrentItem() {
    const tvContext = currentTvContext();
    if (!tvContext) {
      resetEpisodesForMovie();
      return;
    }

    setEpisodesTabAvailability(true);
    episodesView.tmdbId = tvContext.tmdbId;
    episodesView.seasonNumber = tvContext.season;
    setEpisodesMeta("Loading programme seasons...");
    setSeasonSelectPlaceholder("Loading seasons...");
    setEpisodesStatus("Loading programme seasons...", "loading");

    const requestId = ++episodeRequests.showRequestId;
    episodeRequests.showController?.abort();
    const controller = new AbortController();
    episodeRequests.showController = controller;

    try {
      const showDetails = await getTvDetails(tvContext.tmdbId, controller.signal);
      if (controller.signal.aborted || requestId !== episodeRequests.showRequestId) return;

      const latestContext = currentTvContext();
      if (!latestContext || latestContext.tmdbId !== tvContext.tmdbId) return;

      episodesView.showName = showDetails.name || latestContext.title || `TV ${latestContext.tmdbId}`;
      setEpisodesMeta(`${episodesView.showName} episode metadata comes from TMDB.`);

      const seasonToLoad = populateSeasonSelect(showDetails, latestContext.season);
      if (seasonToLoad === null) {
        setEpisodesStatus("No seasons were returned for this TV programme.", "empty");
        return;
      }

      await loadSeasonEpisodes(latestContext.tmdbId, seasonToLoad);
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (isTmdbTokenUnavailableError(error)) {
        handleTmdbTokenUnavailable(
          error instanceof Error ? error.message : "TMDB episode metadata is unavailable right now."
        );
      }
      setSeasonSelectPlaceholder("Unable to load seasons");
      setEpisodesStatus(
        error instanceof Error ? error.message : "Episode metadata could not be loaded.",
        "error"
      );
    }
  }

  function loadPlayer(item, settings) {
    currentItem = item;
    currentUrl = buildUrl(item, settings);

    elements.heading.textContent = displayTitle(item);
    elements.emptyState.hidden = true;
    elements.iframe.hidden = false;
    elements.progressArea.hidden = false;
    elements.copyUrl.disabled = false;
    elements.open.disabled = false;
    elements.iframe.src = currentUrl;

    const saved = settings.resume ? getSavedProgress(item) : null;
    resetProgressDisplay(saved);
    addToHistory(item, saved);
    updateEpisodeSelectionHighlight();

    if (item.type === "tv" && tmdbTokenConfigured) {
      syncEpisodesForCurrentItem();
    } else if (item.type === "tv") {
      resetEpisodesForMissingToken();
    } else {
      resetEpisodesForMovie();
    }

    refreshConnectionStatus();
  }

  function validateForm() {
    const tmdbId = String(elements.tmdb.value).trim();
    if (!tmdbId && tmdbTokenConfigured) {
      throw new Error("Search TMDB and select a movie or TV programme first.");
    }
    if (!/^\d+$/.test(tmdbId)) throw new Error("Enter a valid numerical TMDB ID.");

    const type = getMediaType();
    const color = sanitizeHex(elements.colorInput.value);
    if (!/^[a-f0-9]{6}$/.test(color)) {
      throw new Error("Enter a six-character hexadecimal colour, such as e50914.");
    }

    const item = { type, tmdbId, title: elements.title.value.trim() };

    if (type === "tv") {
      const season = numericValue(elements.season.value, 0, 999);
      const episode = numericValue(elements.episode.value, 1, 9999);
      if (season === null || episode === null) {
        throw new Error("Season must be 0 or higher, and episode must be a positive whole number.");
      }
      item.season = season;
      item.episode = episode;
    }

    return {
      item,
      settings: {
        color,
        autoPlay: elements.autoplay.checked,
        resume: elements.resume.checked,
        episodeSelector: elements.episodeSelector.checked,
        nextEpisode: elements.nextEpisode.checked
      }
    };
  }

  function updateTokenUi(status) {
    tmdbTokenConfigured = Boolean(status?.configured);
    updateTmdbModeUi();
    refreshConnectionStatus();
  }

  function handleTmdbTokenUnavailable(message) {
    updateTokenUi({ configured: false });
    setTmdbModeStatus(message, true);
    if (currentItem?.type === "tv") {
      resetEpisodesForMissingToken();
    }
  }

  async function fetchTokenStatus() {
    try {
      const response = await fetch("/api/tmdb/token-status", {
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not check TMDB token status.");
      }

      updateTokenUi(payload);
      return payload;
    } catch {
      updateTokenUi({ configured: false });
      setTmdbModeStatus("The server could not confirm whether TMDB search is available.", true);
      return null;
    }
  }

  function chooseSearchResult(result) {
    const type = result.mediaType === "tv" ? "tv" : "movie";
    setMediaType(type);
    elements.title.value = result.title || "";
    elements.tmdb.value = String(result.id);

    if (type === "tv") {
      elements.season.value = 1;
      elements.episode.value = 1;
    }

    saveSettings();
    setSearchStatus(`Selected ${result.title}. Loading player...`);
    clearError();
    submitPlayerForm();
  }

  function renderSearchResults(results) {
    elements.searchResults.replaceChildren();

    if (!results.length) {
      elements.searchResults.hidden = true;
      setSearchStatus("No matching movies or TV programmes were found.");
      return;
    }

    results.forEach(result => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";
      button.setAttribute("role", "listitem");

      if (result.posterUrl) {
        const poster = document.createElement("img");
        poster.className = "search-poster";
        poster.src = result.posterUrl;
        poster.alt = "";
        poster.loading = "lazy";
        poster.referrerPolicy = "no-referrer";
        button.append(poster);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "poster-placeholder";
        placeholder.textContent = "No poster";
        button.append(placeholder);
      }

      const copy = document.createElement("span");
      copy.className = "result-copy";

      const heading = document.createElement("span");
      heading.className = "result-heading";

      const title = document.createElement("span");
      title.className = "result-title";
      title.textContent = result.title;

      const badge = document.createElement("span");
      badge.className = "media-badge";
      badge.textContent = result.mediaType === "tv" ? "TV" : "Movie";
      heading.append(title, badge);

      const meta = document.createElement("span");
      meta.className = "result-meta";
      const parts = [result.year || "Year unknown"];
      if (Number.isFinite(result.rating) && result.rating > 0) {
        parts.push(`Rating ${result.rating.toFixed(1)}`);
      }
      meta.textContent = parts.join(" - ");

      const overview = document.createElement("span");
      overview.className = "result-overview";
      overview.textContent = result.overview || "No description available.";

      copy.append(heading, meta, overview);
      button.append(copy);
      button.addEventListener("click", () => chooseSearchResult(result));
      elements.searchResults.append(button);
    });

    elements.searchResults.hidden = false;
    setSearchStatus(`${results.length} result${results.length === 1 ? "" : "s"} found. Select one to load it.`);
  }

  async function searchTmdb() {
    const query = elements.searchInput.value.trim();
    if (query.length < 2) {
      setSearchStatus("Enter at least two characters.", true);
      elements.searchInput.focus();
      return;
    }

    if (!tmdbTokenConfigured) {
      handleTmdbTokenUnavailable("TMDB title search is unavailable on this deployment.");
      return;
    }

    if (searchController) searchController.abort();
    searchController = new AbortController();
    elements.searchButton.disabled = true;
    elements.searchButton.textContent = "Searching...";
    elements.searchResults.hidden = true;
    setSearchStatus("Searching TMDB...");

    try {
      const response = await fetch(`/api/tmdb/search?q=${encodeURIComponent(query)}`, {
        signal: searchController.signal,
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 503) {
          handleTmdbTokenUnavailable(payload.error || "TMDB title search is unavailable right now.");
          return;
        }
        throw new Error(payload.error || `Search failed with status ${response.status}.`);
      }
      renderSearchResults(Array.isArray(payload.results) ? payload.results : []);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setSearchStatus(error instanceof Error ? error.message : "TMDB search failed.", true);
      }
    } finally {
      elements.searchButton.disabled = false;
      elements.searchButton.textContent = "Search";
      searchController = null;
    }
  }

  elements.playerTab.addEventListener("click", () => activateControlsTab("player"));
  elements.episodesTab.addEventListener("click", () => activateControlsTab("episodes"));
  [elements.playerTab, elements.episodesTab].forEach(tab => {
    tab.addEventListener("keydown", handleTabKeydown);
  });

  elements.searchButton.addEventListener("click", searchTmdb);
  elements.searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchTmdb();
    }
  });

  elements.mediaTypes.forEach(input => {
    input.addEventListener("change", () => {
      setMediaType(getMediaType());
      saveSettings();
    });
  });

  elements.colorPicker.addEventListener("input", () => {
    const value = elements.colorPicker.value.slice(1);
    elements.colorInput.value = value;
    updateAccent(value);
    saveSettings();
  });

  elements.colorInput.addEventListener("input", () => {
    const value = sanitizeHex(elements.colorInput.value);
    elements.colorInput.value = value;
    if (value.length === 6) {
      elements.colorPicker.value = `#${value}`;
      updateAccent(value);
      saveSettings();
    }
  });

  elements.seasonSelect.addEventListener("change", () => {
    const seasonNumber = numericValue(elements.seasonSelect.value, 0, 999);
    const tvContext = currentTvContext();
    if (!tvContext || seasonNumber === null) return;
    loadSeasonEpisodes(tvContext.tmdbId, seasonNumber);
  });

  [elements.autoplay, elements.resume, elements.episodeSelector, elements.nextEpisode]
    .forEach(input => input.addEventListener("change", saveSettings));

  elements.form.addEventListener("submit", event => {
    event.preventDefault();
    clearError();

    try {
      const { item, settings } = validateForm();
      saveSettings();
      loadPlayer(item, settings);
    } catch (error) {
      showError(error instanceof Error ? error.message : "The player could not be loaded.");
    }
  });

  elements.copyUrl.addEventListener("click", async () => {
    if (!currentUrl) return;

    try {
      await navigator.clipboard.writeText(currentUrl);
      const original = elements.copyUrl.textContent;
      elements.copyUrl.textContent = "Copied";
      setTimeout(() => {
        elements.copyUrl.textContent = original;
      }, 1400);
    } catch {
      showError("The browser blocked clipboard access. Copy the URL from the separately opened tab instead.");
    }
  });

  elements.open.addEventListener("click", () => {
    if (currentUrl) window.open(currentUrl, "_blank", "noopener,noreferrer");
  });

  elements.clearHistory.addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.history);
      localStorage.removeItem(LEGACY_STORAGE_KEYS.history);
    } catch {
      // Ignore storage errors.
    }
    renderHistory();
  });

  window.addEventListener("message", event => {
    if (event.origin !== VIDKING_ORIGIN) return;
    if (!currentItem || !event.data || event.data.type !== "PLAYER_EVENT") return;

    const data = event.data.data;
    if (!data || typeof data !== "object") return;

    const currentTime = Number(data.currentTime);
    const duration = Number(data.duration);
    const reportedProgress = Number(data.progress);
    const calculatedProgress = Number.isFinite(currentTime) && Number.isFinite(duration) && duration > 0
      ? (currentTime / duration) * 100
      : 0;
    const progress = Number.isFinite(reportedProgress) ? reportedProgress : calculatedProgress;
    const safeProgress = Math.max(0, Math.min(100, progress || 0));

    const progressData = {
      event: String(data.event || ""),
      currentTime: Number.isFinite(currentTime) ? currentTime : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      progress: safeProgress,
      updatedAt: Date.now()
    };

    writeJson(progressStorageKey(currentItem), progressData);
    addToHistory(currentItem, progressData);
    elements.progressFill.style.width = `${safeProgress}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(safeProgress)));
    elements.eventStatus.textContent = eventLabel(progressData.event);
    elements.timeStatus.textContent = `${formatSeconds(progressData.currentTime)} / ${formatSeconds(progressData.duration)}`;
  });

  window.addEventListener("online", refreshConnectionStatus);
  window.addEventListener("offline", refreshConnectionStatus);

  setEpisodesTabAvailability(false);
  refreshConnectionStatus();
  restoreSettings();
  renderHistory();
  fetchTokenStatus();
})();
