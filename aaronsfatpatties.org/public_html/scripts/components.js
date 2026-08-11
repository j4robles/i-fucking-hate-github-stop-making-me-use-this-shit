const VERSE_COUNTS = [
    0, 7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99,
    128, 111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34,
    30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29,
    18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12,
    12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19,
    36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
    11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6
];

const API_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api";
const API_VERSION = "1";
const DEFAULT_EDITION = "ara-jalaladdinalmah";
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 1000 * 60 * 60; //1 hour
const CACHE_PREFIX = "qv-cache:";

const RTL_EDITIONS = /^ara-|^urd-|^fas-|^pes-/;

const QURAN_URL = "https://www.pdfquran.com/en";

class QuranVerse extends HTMLElement {
    static get observedAttributes() {
        //changes which edition is fetched at runtime.
        return ["edition"];
    }

    constructor() {
        super();
        this._controller = null;
        this._timeoutId = null;
        this._onClick = this._onClick.bind(this);
        this._rendered = false;
    }

    get edition() {
        return this.getAttribute("edition") || DEFAULT_EDITION;
    }
    set edition(v) {
        this.setAttribute("edition", v);
    }

    connectedCallback() {
        if (!this._rendered) {
        this._renderComponent();
        this._rendered = true;
        }
        this._setState("idle");
        this._btn.addEventListener("click", this._onClick);
    }

    disconnectedCallback() {
        this._abort();
        if (this._btn) this._btn.removeEventListener("click", this._onClick);
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (name === "edition" && oldVal !== null && oldVal !== newVal) {
            this._abort();
            if (this._rendered) this._setState("idle");
        }
    }

    //rendering======================================================

    _renderComponent() {
        const tpl = document.getElementById("quran-verse-template");
        const frag = tpl.content.cloneNode(true);
        this.appendChild(frag);

        this._textEl = this.querySelector("#qv-verse");
        this._refEl = this.querySelector("cite");
        this._errEl = this.querySelector("#qv-error");
        this._btn = this.querySelector("button");
        this._setButtonLabel("New verse");
    }

    _setButtonLabel(txt) {
        if (this._btn) this._btn.textContent = txt;
    }

    _setState(state) {
        this.dataset.state = state;
        if (this._btn) this._btn.disabled = state === "loading";
    }

    _renderSuccess(data) {
        this._textEl.textContent = data.text || "";
        if (RTL_EDITIONS.test(this.edition)) {
            this._textEl.setAttribute("dir", "rtl");
            this._textEl.setAttribute("lang", "ar");
        } else {
            this._textEl.removeAttribute("dir");
            this._textEl.removeAttribute("lang");
        }
        this._refEl.textContent = "Edition: " + this.edition + " — Chapter " + data.chapter + ", verse " + data.verse;
        this._setButtonLabel("Another verse");
        this._setState("ready");
    }

    _renderError(message) {
        this._errEl.textContent = message;
        this._setButtonLabel("Retry");
        this._setState("error");
    }

    //interaction===========================================

    _onClick() {
        this.load();
    }

    //data====================================================

    _randomRef() {
        const chapter = 1 + Math.floor(Math.random() * (VERSE_COUNTS.length - 1));
        const verse = 1 + Math.floor(Math.random() * VERSE_COUNTS[chapter]);
        return { chapter, verse };
    }

    _cacheKey(edition, chapter, verse) {
        return CACHE_PREFIX + edition + "/" + chapter + "/" + verse;
    }

    _readCache(key) {
        try {
            const raw = sessionStorage.getItem(key);
            if (!raw) return null;
                const entry = JSON.parse(raw);
                if (!entry || typeof entry.t !== "number") return null;
                if (Date.now() - entry.t > CACHE_TTL_MS) {
                    sessionStorage.removeItem(key);
                    return null;
            }
            return entry.d;
        } catch (_) {
            return null;
        }
    }

    _writeCache(key, data) {
        try {
            sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
        } catch (_) {

        }
    }

    _abort() {
        if (this._controller) {
            this._controller.abort();
            this._controller = null;
        }
        if (this._timeoutId !== null) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
        }
    }

    async load() {
        this._abort();

        const edition = this.edition;
        const { chapter, verse } = this._randomRef();
        const key = this._cacheKey(edition, chapter, verse);

        const cached = this._readCache(key);
        if (cached) {
            this._renderSuccess(cached);
            return;
        }

        this._setState("loading");

        const controller = new AbortController();
        this._controller = controller;
        this._timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const endpoint = "editions/" + edition + "/" + chapter + "/" + verse;

        try {
            const data = await this._fetchWithFallback(endpoint, controller.signal);

            if (controller.signal.aborted) return;
            const normalized = {
                chapter: data.chapter ?? chapter,
                verse: data.verse ?? verse,
                text: data.text ?? ""
            };
            this._writeCache(key, normalized);
            this._renderSuccess(normalized);
        } catch (err) {
            console.log(err);
            if (err && err.name === "AbortError") {
                if (!this.isConnected) return;
                    this._renderError("The request timed out. Check your connection and try again.");
            } else {
                this._renderError("Couldn't load a verse right now. Try again later, inshallah.");
            }
        } finally {
            if (this._controller === controller) {
                if (this._timeoutId !== null) {
                    clearTimeout(this._timeoutId);
                    this._timeoutId = null;
                }
                this._controller = null;
            }
        }
    }

    async _fetchWithFallback(endpoint, signal) {
        const url = (suffix) =>
        API_BASE + "@" + API_VERSION + "/" + endpoint + suffix;

        try {
            return await this._fetchJson(url(".json"), signal);
        } catch (err) {
            if (err && err.name === "AbortError") throw err;
            return await this._fetchJson(url(".min.json"), signal);
        }
    }

    async _fetchJson(url, signal) {
        const res = await fetch(url, { signal });
        if (!res.ok) {
            throw new Error("HTTP " + res.status);
        }
        return res.json();
    }
}

customElements.define("quran-verse", QuranVerse);