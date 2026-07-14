import { useState, useEffect, useRef, useMemo } from "react";
import { Plus, X, ArrowLeft, Search, ArrowUpDown, Disc3, ExternalLink, ListMusic, Trash2, Pencil, Upload, CircleCheck, Share, Download, Wand2 } from "lucide-react";
import { supabase } from "./supabaseClient";

const FINISH_OPTIONS = [
  "Standard (opaque)",
  "Transparent",
  "Translucent",
  "Splatter",
  "Split",
  "Marble / Swirl",
  "Glitter",
  "Picture disc",
  "Glow in the dark",
];

// Highlights are additive — a record can be Splatter AND Signed AND Limited at once.
const SPECIAL_TAGS = ["Signed", "Limited"];
const VINYL_SIZES = ["7\"", "12\""];

const COLOR_PRESETS = [
  { label: "Black", hex: "#161616" },
  { label: "Clear", hex: "#dfe6e6" },
  { label: "Red", hex: "#a8342a" },
  { label: "Blue", hex: "#2f4d8a" },
  { label: "Green", hex: "#3a6b4a" },
  { label: "Gold", hex: "#c79a3d" },
  { label: "White", hex: "#eeeeee" },
  { label: "Purple", hex: "#6b3f8a" },
  { label: "Orange", hex: "#c96a2e" },
];

const emptyForm = {
  status: "owned",
  artist: "",
  title: "",
  year: "",
  version: "",
  catalogNo: "",
  label: "",
  genre: "",
  colorLabel: "Black",
  colorHex: "#161616",
  finish: "Standard (opaque)",
  vinylSize: "12\"",
  specialTags: [],
  coverUrl: "",
  discImageUrl: "",
  discImageX: 50,
  discImageY: 50,
  discImageZoom: 100,
  tracklist: "",
  info: "",
};

function formatNumberedList(tracks) {
  return tracks.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

function parseNumberedLines(text) {
  return text
    .split("\n")
    .map((t) => t.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function useDebounced(value, delay) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

// ---------- persistence (Supabase) ----------
// Maps DB rows (snake_case) <-> app records (camelCase)
function rowToRecord(row) {
  return {
    id: row.id,
    status: row.status || "owned",
    artist: row.artist,
    title: row.title,
    year: row.year || "",
    version: row.version || "",
    catalogNo: row.catalog_no || "",
    label: row.label || "",
    genre: row.genre || "",
    colorLabel: row.color_label || "Black",
    colorHex: row.color_hex || "#161616",
    finish: row.finish || "Standard (opaque)",
    vinylSize: row.vinyl_size || "12\"",
    specialTags: row.special_tags || [],
    coverUrl: row.cover_url || "",
    discImageUrl: row.disc_image_url || "",
    discImageX: row.disc_image_x ?? 50,
    discImageY: row.disc_image_y ?? 50,
    discImageZoom: row.disc_image_zoom ?? 100,
    tracklist: row.tracklist || [],
    info: row.info || null,
    addedAt: Number(row.added_at) || Date.now(),
  };
}

function recordToRow(rec) {
  return {
    id: rec.id,
    status: rec.status || "owned",
    artist: rec.artist,
    title: rec.title,
    year: rec.year || "",
    version: rec.version || "",
    catalog_no: rec.catalogNo || "",
    label: rec.label || "",
    genre: rec.genre || "",
    color_label: rec.colorLabel || "Black",
    color_hex: rec.colorHex || "#161616",
    finish: rec.finish || "Standard (opaque)",
    vinyl_size: rec.vinylSize || "12\"",
    special_tags: rec.specialTags || [],
    cover_url: rec.coverUrl || "",
    disc_image_url: rec.discImageUrl || "",
    disc_image_x: rec.discImageX ?? 50,
    disc_image_y: rec.discImageY ?? 50,
    disc_image_zoom: rec.discImageZoom ?? 100,
    tracklist: rec.tracklist || [],
    info: rec.info || null,
    added_at: rec.addedAt || Date.now(),
  };
}

async function loadRecords() {
  const { data, error } = await supabase.from("records").select("*").order("added_at", { ascending: true });
  if (error) {
    console.error("Load failed", error);
    return [];
  }
  return (data || []).map(rowToRecord);
}

async function insertRecordDb(rec) {
  const { error } = await supabase.from("records").insert(recordToRow(rec));
  if (error) throw error;
}

async function updateRecordDb(id, patch) {
  const row = recordToRow(patch);
  delete row.id;
  const { error } = await supabase.from("records").update(row).eq("id", id);
  if (error) throw error;
}

async function deleteRecordDb(id) {
  const { error } = await supabase.from("records").delete().eq("id", id);
  if (error) throw error;
}

// ---------- image uploads (Supabase Storage) ----------
async function uploadImageToStorage(dataUrlOrBlob, path) {
  let blob = dataUrlOrBlob;
  if (typeof dataUrlOrBlob === "string" && dataUrlOrBlob.startsWith("data:")) {
    const res = await fetch(dataUrlOrBlob);
    blob = await res.blob();
  }
  const { error } = await supabase.storage.from("covers").upload(path, blob, {
    upsert: true,
    contentType: "image/jpeg",
  });
  if (error) throw error;
  const { data } = supabase.storage.from("covers").getPublicUrl(path);
  return data.publicUrl;
}

async function deleteImageFromStorage(path) {
  try {
    await supabase.storage.from("covers").remove([path]);
  } catch (e) {
    // best effort, nothing to clean up
  }
}

// Resize + compress an uploaded image file into a compact JPEG data URL,
// so a phone photo doesn't blow past reasonable upload size.
function resizeImageFile(file, maxSize = 800, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't load that image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else if (height >= width && height > maxSize) {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- generate a shareable "My Collection" grid image ----------
async function resolveRecordCoverSrc(record) {
  return record.coverUrl || null;
}

function loadImageEl(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function generateCollectionImage(records) {
  const ordered = [...records].sort((a, b) => a.addedAt - b.addedAt);
  const TARGET_WIDTH = 1920;
  const padding = 90;
  const gap = 22;
  const titleHeight = 230;
  const cols = Math.min(8, Math.max(3, Math.round(Math.sqrt(ordered.length || 1) * 1.6)));
  const cell = Math.round((TARGET_WIDTH - padding * 2 - (cols - 1) * gap) / cols);
  const rows = Math.max(1, Math.ceil(ordered.length / cols));
  const width = TARGET_WIDTH;
  const height = titleHeight + padding + rows * cell + (rows - 1) * gap + padding;

  const sources = await Promise.all(ordered.map((r) => resolveRecordCoverSrc(r)));
  const images = await Promise.all(sources.map((src) => loadImageEl(src)));

  function paint(ctx, useOnlySafeImages) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#f5f3ee";
    const titleSize = 78;
    ctx.font = `600 ${titleSize}px Inter, sans-serif`;
    ctx.textBaseline = "alphabetic";
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${(titleSize * 0.09).toFixed(1)}px`;
    ctx.fillText("MY COLLECTION", padding, 128);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

    ctx.font = `500 26px 'IBM Plex Mono', 'Courier New', monospace`;
    ctx.fillStyle = "#9a968a";
    ctx.fillText(`${ordered.length} pressing${ordered.length === 1 ? "" : "s"}`, padding, 172);

    ordered.forEach((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padding + col * (cell + gap);
      const y = titleHeight + padding + row * (cell + gap);
      const src = sources[i];
      const isSafe = src && (src.startsWith("data:") || src.includes(".supabase.co/"));
      const img = images[i];
      if (img && (!useOnlySafeImages || isSafe)) {
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        ctx.drawImage(img, sx, sy, s, s, x, y, cell, cell);
      } else {
        ctx.fillStyle = r.colorHex || "#333";
        ctx.fillRect(x, y, cell, cell);
      }
    });
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  paint(ctx, false);
  try {
    return { dataUrl: canvas.toDataURL("image/png"), degraded: false };
  } catch (e) {
    // Some cover came from a source that blocks cross-origin canvas export.
    // Redraw using only same-origin (uploaded) images, color blocks for the rest.
    paint(ctx, true);
    return { dataUrl: canvas.toDataURL("image/png"), degraded: true };
  }
}

// ---------- streaming search links ----------
function streamLinks(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    ytmusic: `https://music.youtube.com/search?q=${q}`,
    apple: `https://music.apple.com/us/search?term=${q}`,
  };
}

function geniusLink(artist, track) {
  return `https://genius.com/search?q=${encodeURIComponent(`${artist} ${track}`)}`;
}

// ---------- AI auto-fill via Supabase Edge Function proxy ----------
async function callClaudeProxy(prompt, maxTokens = 800) {
  const { data, error } = await supabase.functions.invoke("claude-proxy", {
    body: { prompt, max_tokens: maxTokens },
  });
  if (error) throw error;
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return text;
}

async function fetchAlbumStory(artist, title, year) {
  const prompt = `Give a short, factual background on the album "${title}" by ${artist}${year ? ` (${year})` : ""}. Cover: when/how it was recorded, its context or reception, and one interesting fact. Plain prose, 3-5 sentences, no headers, no markdown, no lyrics or quoted lyrics.`;
  const text = await callClaudeProxy(prompt, 1000);
  return text || "No background found for this pressing.";
}

async function fetchLabelGenre(artist, title, year) {
  const prompt = `For the album "${title}" by ${artist}${year ? ` (${year})` : ""}, find the original record label and its music genre(s). Respond with ONLY a JSON object like {"label": "Columbia Records", "genre": "Pop, Electropop"} and nothing else — no markdown, no code fences, no commentary. Use short, common genre names (e.g. Pop, Rock, Indie, Hip-Hop, Electronic). If either is genuinely unknown, use an empty string for that field.`;
  const text = await callClaudeProxy(prompt, 400);
  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : cleaned);
  return {
    label: parsed && parsed.label ? String(parsed.label).trim() : "",
    genre: parsed && parsed.genre ? String(parsed.genre).trim() : "",
  };
}

async function fetchTracklist(artist, title, year) {
  const prompt = `Find the official tracklist for the album "${title}" by ${artist}${year ? ` (${year})` : ""}. Respond with ONLY a JSON array of the track titles as strings, in the correct running order, and nothing else — no markdown, no code fences, no commentary.`;
  const text = await callClaudeProxy(prompt, 1000);
  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(match ? match[0] : cleaned);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("No tracklist found");
  return parsed.map((t) => String(t).trim()).filter(Boolean);
}


// ================= APP =================
export default function VinylCrate() {
  const [records, setRecords] = useState(null); // null = loading
  const [view, setView] = useState("grid"); // grid | detail | lyrics
  const [selectedId, setSelectedId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 150);
  const [sortField, setSortField] = useState("addedAt");
  const [sortDir, setSortDir] = useState("asc");
  const [colorFilter, setColorFilter] = useState(null);
  const [finishFilter, setFinishFilter] = useState(null);
  const [tagFilter, setTagFilter] = useState(null);
  const [genreFilter, setGenreFilter] = useState(null);
  const [sizeFilter, setSizeFilter] = useState(null);
  const [saveError, setSaveError] = useState(false);
  const [activeTab, setActiveTab] = useState("collection"); // collection | wishlist
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let active = true;
    loadRecords().then((r) => {
      if (active) setRecords(r);
    });

    const channel = supabase
      .channel("records-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, () => {
        loadRecords().then((r) => {
          if (active) setRecords(r);
        });
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  function switchTab(tab) {
    setActiveTab(tab);
    setColorFilter(null);
    setFinishFilter(null);
    setTagFilter(null);
    setGenreFilter(null);
    setSizeFilter(null);
    setQuery("");
  }

  const scopedRecords = useMemo(() => {
    if (!records) return null;
    return records.filter((r) => (r.status || "owned") === (activeTab === "wishlist" ? "wishlist" : "owned"));
  }, [records, activeTab]);

  const collectionCount = useMemo(() => (records ? records.filter((r) => (r.status || "owned") === "owned").length : 0), [records]);
  const wishlistCount = useMemo(() => (records ? records.filter((r) => r.status === "wishlist").length : 0), [records]);

  const entryNumbers = useMemo(() => {
    if (!scopedRecords) return {};
    const ordered = [...scopedRecords].sort((a, b) => a.addedAt - b.addedAt);
    const map = {};
    ordered.forEach((r, i) => (map[r.id] = i + 1));
    return map;
  }, [scopedRecords]);

  const distinctColors = useMemo(() => {
    if (!scopedRecords) return [];
    const map = new Map();
    scopedRecords.forEach((r) => {
      if (!map.has(r.colorLabel)) map.set(r.colorLabel, r.colorHex);
    });
    return Array.from(map.entries());
  }, [scopedRecords]);

  const distinctFinishes = useMemo(() => {
    if (!scopedRecords) return [];
    const set = new Set();
    scopedRecords.forEach((r) => r.finish && set.add(r.finish));
    return Array.from(set);
  }, [scopedRecords]);

  const distinctGenres = useMemo(() => {
    if (!scopedRecords) return [];
    const set = new Set();
    scopedRecords.forEach((r) => {
      (r.genre || "").split(",").map((g) => g.trim()).filter(Boolean).forEach((g) => set.add(g));
    });
    return Array.from(set);
  }, [scopedRecords]);

  const distinctSizes = useMemo(() => {
    if (!scopedRecords) return [];
    const set = new Set();
    scopedRecords.forEach((r) => set.add(r.vinylSize || "12\""));
    return Array.from(set);
  }, [scopedRecords]);

  const distinctTags = useMemo(() => {
    if (!scopedRecords) return [];
    const set = new Set();
    scopedRecords.forEach((r) => (r.specialTags || []).forEach((t) => set.add(t)));
    return Array.from(set);
  }, [scopedRecords]);

  const filtered = useMemo(() => {
    if (!scopedRecords) return [];
    let list = scopedRecords;
    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase();
      list = list.filter(
        (r) =>
          r.artist.toLowerCase().includes(q) ||
          r.title.toLowerCase().includes(q) ||
          (r.catalogNo || "").toLowerCase().includes(q)
      );
    }
    if (colorFilter) {
      list = list.filter((r) => r.colorLabel === colorFilter);
    }
    if (finishFilter) {
      list = list.filter((r) => r.finish === finishFilter);
    }
    if (tagFilter) {
      list = list.filter((r) => (r.specialTags || []).includes(tagFilter));
    }
    if (genreFilter) {
      list = list.filter((r) => (r.genre || "").split(",").map((g) => g.trim()).includes(genreFilter));
    }
    if (sizeFilter) {
      list = list.filter((r) => (r.vinylSize || "12\"") === sizeFilter);
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      let av = a[sortField] ?? "";
      let bv = b[sortField] ?? "";
      if (sortField === "year" || sortField === "addedAt") {
        av = Number(av) || 0;
        bv = Number(bv) || 0;
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [scopedRecords, debouncedQuery, colorFilter, finishFilter, tagFilter, genreFilter, sizeFilter, sortField, sortDir]);

  const selected = records ? records.find((r) => r.id === selectedId) : null;

  function openAdd() {
    if (records === null) return;
    setForm({ ...emptyForm, status: activeTab === "wishlist" ? "wishlist" : "owned" });
    setEditingId(null);
    setFormOpen(true);
  }

  function openEdit(rec) {
    setForm({
      status: rec.status || "owned",
      artist: rec.artist,
      title: rec.title,
      year: rec.year,
      version: rec.version,
      catalogNo: rec.catalogNo,
      label: rec.label || "",
      genre: rec.genre || "",
      colorLabel: rec.colorLabel,
      colorHex: rec.colorHex,
      finish: rec.finish || "Standard (opaque)",
      vinylSize: rec.vinylSize || "12\"",
      specialTags: rec.specialTags || [],
      coverUrl: rec.coverUrl,
      discImageUrl: rec.discImageUrl || "",
      discImageX: rec.discImageX ?? 50,
      discImageY: rec.discImageY ?? 50,
      discImageZoom: rec.discImageZoom ?? 100,
      tracklist: formatNumberedList(rec.tracklist || []),
      info: rec.info || "",
    });
    setEditingId(rec.id);
    setFormOpen(true);
  }

  async function submitForm(e) {
    e.preventDefault();
    if (!form.artist.trim() || !form.title.trim()) return;
    const tracklist = parseNumberedLines(form.tracklist);
    const base = records || [];
    const recId = editingId || uid();

    let coverField = form.coverUrl;
    let discField = form.discImageUrl;

    try {
      if (coverField && coverField.startsWith("data:")) {
        coverField = await uploadImageToStorage(coverField, `cover-${recId}-${Date.now()}.jpg`);
      }
      if (discField && discField.startsWith("data:")) {
        discField = await uploadImageToStorage(discField, `disc-${recId}-${Date.now()}.jpg`);
      }

      const rec = {
        ...form,
        id: recId,
        tracklist,
        coverUrl: coverField,
        discImageUrl: discField,
        addedAt: editingId ? (base.find((r) => r.id === editingId) || {}).addedAt || Date.now() : Date.now(),
      };

      if (editingId) {
        await updateRecordDb(editingId, rec);
        setRecords(base.map((r) => (r.id === editingId ? rec : r)));
      } else {
        await insertRecordDb(rec);
        setRecords([rec, ...base]);
      }
      setSaveError(false);
    } catch (err) {
      console.error("Couldn't save record", err);
      setSaveError(true);
    } finally {
      setFormOpen(false);
    }
  }

  async function deleteRecord(id) {
    const rec = records.find((r) => r.id === id);
    const next = records.filter((r) => r.id !== id);
    setRecords(next);
    try {
      await deleteRecordDb(id);
    } catch (err) {
      console.error("Couldn't delete record", err);
      setSaveError(true);
    }
    if (selectedId === id) {
      setView("grid");
      setSelectedId(null);
    }
  }

  async function saveInfo(id, info) {
    setRecords(records.map((r) => (r.id === id ? { ...r, info } : r)));
    try {
      await updateRecordDb(id, { ...records.find((r) => r.id === id), info });
    } catch (err) {
      console.error("Couldn't save info", err);
      setSaveError(true);
    }
  }

  async function moveToCollection(id) {
    setRecords(records.map((r) => (r.id === id ? { ...r, status: "owned" } : r)));
    try {
      await updateRecordDb(id, { ...records.find((r) => r.id === id), status: "owned" });
    } catch (err) {
      console.error("Couldn't move to collection", err);
      setSaveError(true);
    }
  }

  return (
    <div className="vc-root">
      <style>{CSS}</style>

      <header className="vc-header">
        <div className="vc-brand">
          <Disc3 className="vc-brand-icon" size={24} strokeWidth={1.3} />
          <div>
            <h1>Sub Del's Vinyl Vault</h1>
            <p>Collection archive</p>
          </div>
        </div>
        <div className="vc-header-actions">
          {view === "grid" && activeTab !== "history" && scopedRecords && scopedRecords.length > 0 && (
            <span className="vc-tally">{scopedRecords.length} {activeTab === "wishlist" ? "wanted" : "pressing"}{scopedRecords.length === 1 ? "" : "s"}</span>
          )}
          {view === "grid" && activeTab !== "history" && (
            session ? (
              <button
                className="vc-btn vc-btn-primary"
                onClick={openAdd}
                disabled={records === null}
                title={records === null ? "Loading your vault…" : undefined}
              >
                <Plus size={16} strokeWidth={2} />
                {activeTab === "wishlist" ? "Add to Wishlist" : "Add Record"}
              </button>
            ) : null
          )}
          {!authLoading && (
            session ? (
              <button className="vc-btn vc-btn-ghost vc-btn-sm" onClick={() => supabase.auth.signOut()}>
                Sign out
              </button>
            ) : (
              <button className="vc-btn vc-btn-ghost vc-btn-sm" onClick={() => setLoginOpen(true)}>
                Sign in
              </button>
            )
          )}
        </div>
      </header>

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}

      {view === "grid" && (
        <nav className="vc-tabs">
          <button
            className={`vc-tab ${activeTab === "collection" ? "is-active" : ""}`}
            onClick={() => switchTab("collection")}
          >
            Vault <span className="vc-tab-count">{collectionCount}</span>
          </button>
          <button
            className={`vc-tab ${activeTab === "wishlist" ? "is-active" : ""}`}
            onClick={() => switchTab("wishlist")}
          >
            Wishlist <span className="vc-tab-count">{wishlistCount}</span>
          </button>
          <button
            className={`vc-tab ${activeTab === "history" ? "is-active" : ""}`}
            onClick={() => switchTab("history")}
          >
            Collection <span className="vc-tab-count">{collectionCount + wishlistCount}</span>
          </button>
        </nav>
      )}

      {view === "grid" && activeTab === "history" && (
        <HistoryView
          loading={records === null}
          records={records || []}
          onOpen={(id) => {
            setSelectedId(id);
            setView("detail");
          }}
        />
      )}

      {view === "grid" && activeTab !== "history" && (
        <GridView
          loading={records === null}
          records={filtered}
          total={scopedRecords ? scopedRecords.length : 0}
          activeTab={activeTab}
          canEdit={!!session}
          entryNumbers={entryNumbers}
          query={query}
          setQuery={setQuery}
          sortField={sortField}
          setSortField={setSortField}
          sortDir={sortDir}
          setSortDir={setSortDir}
          distinctColors={distinctColors}
          colorFilter={colorFilter}
          setColorFilter={setColorFilter}
          distinctFinishes={distinctFinishes}
          finishFilter={finishFilter}
          setFinishFilter={setFinishFilter}
          distinctTags={distinctTags}
          tagFilter={tagFilter}
          setTagFilter={setTagFilter}
          distinctGenres={distinctGenres}
          genreFilter={genreFilter}
          setGenreFilter={setGenreFilter}
          distinctSizes={distinctSizes}
          sizeFilter={sizeFilter}
          setSizeFilter={setSizeFilter}
          onOpen={(id) => {
            setSelectedId(id);
            setView("detail");
          }}
          onAdd={openAdd}
          saveError={saveError}
        />
      )}

      {view === "detail" && selected && (
        <DetailView
          record={selected}
          entryNo={entryNumbers[selected.id]}
          canEdit={!!session}
          onBack={() => {
            setView("grid");
            setSelectedId(null);
          }}
          onEdit={() => openEdit(selected)}
          onDelete={() => deleteRecord(selected.id)}
          onLyrics={() => setView("lyrics")}
          onSaveInfo={(info) => saveInfo(selected.id, info)}
          onMoveToCollection={() => moveToCollection(selected.id)}
        />
      )}

      {view === "lyrics" && selected && (
        <LyricsView record={selected} onBack={() => setView("detail")} />
      )}

      {formOpen && (
        <FormModal
          form={form}
          setForm={setForm}
          editing={!!editingId}
          onClose={() => setFormOpen(false)}
          onSubmit={submitForm}
        />
      )}
    </div>
  );
}

// ================= GRID VIEW =================
// ================= HISTORY (4-column grid of everything ever added) =================
function HistoryView({ loading, records, onOpen }) {
  const ordered = useMemo(() => [...records].sort((a, b) => b.addedAt - a.addedAt), [records]);

  return (
    <main className="vc-main">
      {loading && (
        <div className="vc-empty">
          <Disc3 className="vc-spin-slow" size={40} strokeWidth={1} />
          <p>Loading your vault…</p>
        </div>
      )}
      {!loading && ordered.length === 0 && (
        <div className="vc-empty">
          <p>Nothing added yet — records will show up here as you catalogue them.</p>
        </div>
      )}
      {!loading && ordered.length > 0 && (
        <>
          <div className="vc-history-grid">
            {ordered.map((r) => (
              <button key={r.id} className="vc-history-tile" onClick={() => onOpen(r.id)} title={`${r.title} — ${r.artist}`}>
                <CoverArt coverUrl={r.coverUrl} artist={r.artist} title={r.title} hex={r.colorHex} alt={`${r.title} cover`} />
                {r.status === "wishlist" && <span className="vc-history-badge">Wishlist</span>}
              </button>
            ))}
          </div>
          <ShareCollectionButton records={ordered} />
        </>
      )}
    </main>
  );
}

function LoginModal({ onClose }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError("Couldn't sign in — check your email and password.");
    } else {
      onClose();
    }
  }

  return (
    <div className="vc-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vc-modal" style={{ maxWidth: 380 }}>
        <div className="vc-modal-head">
          <h3>Sign in</h3>
          <button type="button" className="vc-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label className="vc-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="vc-field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p className="vc-error">{error}</p>}
          <div className="vc-modal-actions">
            <button type="button" className="vc-btn vc-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="vc-btn vc-btn-primary" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ShareCollectionButton({ records }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function handleClick() {
    setOpen(true);
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await generateCollectionImage(records);
      setResult(res);
    } catch (e) {
      console.error(e);
      setError("Couldn't generate the image — try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result.dataUrl;
    a.download = "my-collection.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <>
      <button className="vc-fab" onClick={handleClick} title="Share your collection">
        <Share size={21} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="vc-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="vc-share-modal">
            <div className="vc-modal-head">
              <h3>Share your collection</h3>
              <button type="button" className="vc-icon-btn" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </div>
            {loading && <p className="vc-muted">Generating your collection image…</p>}
            {error && <p className="vc-error">{error}</p>}
            {result && (
              <>
                <img src={result.dataUrl} alt="My Collection" className="vc-share-preview" />
                {result.degraded && (
                  <p className="vc-muted">
                    A few covers came from sites that block sharing their images this way, so those show as color blocks instead.
                  </p>
                )}
                <button className="vc-btn vc-btn-primary" onClick={handleDownload}>
                  <Download size={15} /> Save image
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function GridView({
  loading,
  records,
  total,
  activeTab,
  canEdit,
  entryNumbers,
  query,
  setQuery,
  sortField,
  setSortField,
  sortDir,
  setSortDir,
  distinctColors,
  colorFilter,
  setColorFilter,
  distinctFinishes,
  finishFilter,
  setFinishFilter,
  distinctTags,
  tagFilter,
  setTagFilter,
  distinctGenres,
  genreFilter,
  setGenreFilter,
  distinctSizes,
  sizeFilter,
  setSizeFilter,
  onOpen,
  onAdd,
  saveError,
}) {
  return (
    <main className="vc-main">
      <div className="vc-toolbar">
        <div className="vc-search">
          <Search size={15} strokeWidth={2} />
          <input
            placeholder="Search artist, title, catalog #"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="vc-sort">
          <select value={sortField} onChange={(e) => setSortField(e.target.value)}>
            <option value="addedAt">Added order</option>
            <option value="artist">Artist</option>
            <option value="title">Album title</option>
            <option value="year">Year</option>
            <option value="colorLabel">Vinyl color</option>
            <option value="finish">Finish</option>
            <option value="version">Version</option>
          </select>
          <button
            className="vc-icon-btn"
            title="Toggle sort direction"
            onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}
          >
            <ArrowUpDown size={14} strokeWidth={2} />
            {sortField === "addedAt"
              ? sortDir === "asc" ? "Oldest first" : "Newest first"
              : sortField === "year"
              ? sortDir === "asc" ? "Oldest first" : "Newest first"
              : sortDir === "asc" ? "A–Z" : "Z–A"}
          </button>
        </div>
      </div>

      {distinctColors.length > 0 && (
        <div className="vc-chip-group">
          <span className="vc-chip-group-label">Color</span>
          <div className="vc-chips">
            <button
              className={`vc-chip ${colorFilter === null ? "is-active" : ""}`}
              onClick={() => setColorFilter(null)}
            >
              All
            </button>
            {distinctColors.map(([label, hex]) => (
              <button
                key={label}
                className={`vc-chip ${colorFilter === label ? "is-active" : ""}`}
                onClick={() => setColorFilter(colorFilter === label ? null : label)}
              >
                <span className="vc-chip-dot" style={{ background: hex }} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {distinctFinishes.length > 0 && (
        <div className="vc-chip-group">
          <span className="vc-chip-group-label">Finish</span>
          <div className="vc-chips">
            <button
              className={`vc-chip ${finishFilter === null ? "is-active" : ""}`}
              onClick={() => setFinishFilter(null)}
            >
              All
            </button>
            {distinctFinishes.map((label) => (
              <button
                key={label}
                className={`vc-chip ${finishFilter === label ? "is-active" : ""}`}
                onClick={() => setFinishFilter(finishFilter === label ? null : label)}
              >
                <FinishIcon type={label} size={14} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {distinctTags.length > 0 && (
        <div className="vc-chip-group">
          <span className="vc-chip-group-label">Highlights</span>
          <div className="vc-chips">
            <button
              className={`vc-chip ${tagFilter === null ? "is-active" : ""}`}
              onClick={() => setTagFilter(null)}
            >
              All
            </button>
            {distinctTags.map((tag) => (
              <button
                key={tag}
                className={`vc-chip ${tagFilter === tag ? "is-active" : ""}`}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                <FinishIcon type={tag} size={14} />
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {distinctGenres.length > 0 && (
        <div className="vc-chip-group">
          <span className="vc-chip-group-label">Genre</span>
          <div className="vc-chips">
            <button
              className={`vc-chip ${genreFilter === null ? "is-active" : ""}`}
              onClick={() => setGenreFilter(null)}
            >
              All
            </button>
            {distinctGenres.map((g) => (
              <button
                key={g}
                className={`vc-chip ${genreFilter === g ? "is-active" : ""}`}
                onClick={() => setGenreFilter(genreFilter === g ? null : g)}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      )}

      {distinctSizes.length > 0 && (
        <div className="vc-chip-group">
          <span className="vc-chip-group-label">Size</span>
          <div className="vc-chips">
            <button
              className={`vc-chip ${sizeFilter === null ? "is-active" : ""}`}
              onClick={() => setSizeFilter(null)}
            >
              All
            </button>
            {distinctSizes.map((s) => (
              <button
                key={s}
                className={`vc-chip ${sizeFilter === s ? "is-active" : ""}`}
                onClick={() => setSizeFilter(sizeFilter === s ? null : s)}
              >
                <SizeIcon vinylSize={s} size={14} />
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {saveError && (
        <div className="vc-warning">Couldn't save to storage — your last change may not persist.</div>
      )}

      {loading && (
        <div className="vc-empty">
          <Disc3 className="vc-spin-slow" size={40} strokeWidth={1} />
          <p>Loading your vault…</p>
        </div>
      )}

      {!loading && total === 0 && (
        <div className="vc-empty">
          <Disc3 size={40} strokeWidth={1} />
          <h3>{activeTab === "wishlist" ? "Your wishlist is empty" : "Your vault is empty"}</h3>
          <p>{activeTab === "wishlist" ? "Add a record you're hunting for to start tracking it." : "Add your first record to start the collection."}</p>
          {canEdit && (
            <button className="vc-btn vc-btn-primary" onClick={onAdd}>
              <Plus size={16} />
              {activeTab === "wishlist" ? "Add to Wishlist" : "Add Record"}
            </button>
          )}
        </div>
      )}

      {!loading && total > 0 && records.length === 0 && (
        <div className="vc-empty">
          <p>No records match this search or filter.</p>
        </div>
      )}

      {!loading && records.length > 0 && (
        <div className="vc-grid">
          {records.map((r, i) => (
            <button
              key={r.id}
              className="vc-sleeve"
              style={{ "--i": i }}
              onClick={() => onOpen(r.id)}
            >
              <span className="vc-sleeve-stage">
                <span className="vc-sleeve-cover">
                  <CoverArt coverUrl={r.coverUrl} artist={r.artist} title={r.title} hex={r.colorHex} alt={`${r.title} cover`} />
                  <span className="vc-sleeve-no">No. {String(entryNumbers[r.id] || 0).padStart(3, "0")}</span>
                  {(() => {
                    const badges = [...(r.specialTags || []), ...(r.vinylSize === "7\"" ? ["7\""] : [])];
                    return badges.length > 0 ? <span className="vc-sleeve-highlight">{badges.join(" · ")}</span> : null;
                  })()}
                </span>
                <span className="vc-sleeve-disc">
                  <DiscFace record={r} />
                </span>
              </span>
              <span className="vc-sleeve-meta">
                <strong>{r.title}</strong>
                <span>{r.artist}</span>
                <span className="vc-mono">{r.year || "—"}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

function SizeIcon({ vinylSize, size = 22 }) {
  const r = vinylSize === "7\"" ? 8 : 13;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r={r} fill="currentColor" />
      <circle cx="16" cy="16" r={r * 0.32} fill="var(--paper)" />
    </svg>
  );
}

function FinishIcon({ type, size = 22 }) {
  const common = { width: size, height: size, viewBox: "0 0 32 32", fill: "none", "aria-hidden": true };
  switch (type) {
    case "Standard (opaque)":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
        </svg>
      );
    case "Transparent":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      );
    case "Translucent":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.35" />
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      );
    case "Splatter":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.85" />
          <circle cx="11" cy="10" r="1.4" fill="var(--paper)" />
          <circle cx="21" cy="9.5" r="1" fill="var(--paper)" />
          <circle cx="20.5" cy="18" r="1.6" fill="var(--paper)" />
          <circle cx="12" cy="21" r="1.1" fill="var(--paper)" />
          <circle cx="17" cy="14" r="0.9" fill="var(--paper)" />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
        </svg>
      );
    case "Split":
      return (
        <svg {...common}>
          <path d="M16 3a13 13 0 000 26z" fill="currentColor" />
          <path d="M16 3a13 13 0 010 26z" fill="currentColor" opacity="0.3" />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
        </svg>
      );
    case "Marble / Swirl":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.45" />
          <path d="M5.5 13c4-6 11-6 15 0s7 7 5 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      );
    case "Glitter":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.85" />
          <path d="M10 8l0.8 2 2 0.8-2 0.8-0.8 2-0.8-2-2-0.8 2-0.8z" fill="var(--paper)" />
          <path d="M22 12l0.6 1.5 1.5 0.6-1.5 0.6-0.6 1.5-0.6-1.5-1.5-0.6 1.5-0.6z" fill="var(--paper)" />
          <path d="M12 21l0.6 1.5 1.5 0.6-1.5 0.6-0.6 1.5-0.6-1.5-1.5-0.6 1.5-0.6z" fill="var(--paper)" />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
        </svg>
      );
    case "Picture disc":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6.5 20.5l5.5-6 3.5 3.5 4.5-6.5 5.5 8" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx="12" cy="10.5" r="1.4" fill="currentColor" />
        </svg>
      );
    case "Glow in the dark":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.2" />
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      );
    case "Signed":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.85" />
          <path d="M8 19c1.5-3 2.5-5 4-5s1 3.5 2.5 3.5 2-5 3.5-5 1 4 2.5 4 1.5-2 2.5-2" stroke="var(--paper)" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Limited":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="11" fill="currentColor" />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
          <path d="M11 25l-2.5 4 3-0.6 1.5 2.6 2-4.6M21 25l2.5 4-3-0.6-1.5 2.6-2-4.6" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" />
        </svg>
      );
  }
}

function DiscFace({ record }) {
  const discImg = record.discImageUrl || null;
  if (discImg) {
    const x = record.discImageX ?? 50;
    const y = record.discImageY ?? 50;
    const zoom = (record.discImageZoom || 100) / 100;
    return (
      <span className="vc-disc-face">
        <img
          className="vc-disc-face-img"
          src={discImg}
          alt=""
          style={{ objectPosition: `${x}% ${y}%`, transform: `scale(${zoom})` }}
        />
      </span>
    );
  }
  return (
    <span
      className="vc-disc-face vc-disc-face-plain"
      style={{ background: `radial-gradient(circle at 50% 50%, transparent 0 18%, ${record.colorHex} 19% 46%, transparent 47% 48%, ${record.colorHex} 49% 100%)` }}
    >
      <span className="vc-disc-label" style={{ background: record.colorHex }}>
        <span className="vc-disc-hole" />
      </span>
    </span>
  );
}

function SpotifyIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="11" fill="#0b0b0d" />
      <path d="M6.8 9.6c3.6-1 7.9-.7 10.8.9" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M7.1 12.8c3-.8 6.5-.5 9 .9" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" fill="none" />
      <path d="M7.5 15.8c2.4-.6 5.1-.4 7.1.7" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function YouTubeMusicIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="11" fill="#0b0b0d" />
      <circle cx="12" cy="12" r="6.3" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path d="M10.3 9.2l4.4 2.8-4.4 2.8z" fill="#fff" />
    </svg>
  );
}

function AppleMusicIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        fill="#0b0b0d"
        d="M31.995 8.167c0-0.984-0.083-1.964-0.318-2.922-0.422-1.745-1.417-3.078-2.906-4.057-0.766-0.5-1.609-0.807-2.505-0.969-0.688-0.125-1.385-0.182-2.083-0.198-0.052-0.005-0.109-0.016-0.167-0.021h-16.031c-0.203 0.016-0.406 0.026-0.609 0.036-0.995 0.057-1.984 0.161-2.922 0.536-1.781 0.703-3.068 1.932-3.818 3.703-0.26 0.599-0.391 1.234-0.484 1.88-0.078 0.521-0.12 1.047-0.135 1.573 0 0.042-0.010 0.083-0.010 0.125v16.297c0.010 0.188 0.021 0.375 0.031 0.563 0.068 1.089 0.208 2.167 0.667 3.167 0.865 1.891 2.318 3.135 4.313 3.734 0.557 0.172 1.141 0.25 1.724 0.302 0.74 0.073 1.479 0.083 2.219 0.083h14.708c0.698 0 1.396-0.047 2.094-0.135 1.099-0.141 2.13-0.464 3.063-1.078 1.12-0.74 1.964-1.719 2.505-2.943 0.25-0.563 0.391-1.161 0.495-1.766 0.151-0.901 0.182-1.813 0.182-2.724-0.005-5.063 0-10.125-0.005-15.188zM23.432 13.484v7.615c0 0.557-0.078 1.104-0.328 1.609-0.385 0.786-1.010 1.281-1.849 1.521-0.464 0.135-0.943 0.208-1.427 0.229-1.266 0.063-2.365-0.797-2.589-2.047-0.193-1.031 0.302-2.167 1.385-2.698 0.427-0.208 0.891-0.333 1.354-0.427 0.505-0.109 1.010-0.208 1.51-0.323 0.37-0.083 0.609-0.307 0.682-0.688 0.021-0.083 0.026-0.172 0.026-0.255 0-2.422 0-4.844 0-7.26 0-0.083-0.016-0.167-0.036-0.245-0.052-0.203-0.198-0.323-0.406-0.313-0.214 0.010-0.422 0.047-0.63 0.089-1.016 0.198-2.031 0.401-3.042 0.609l-4.932 0.995c-0.021 0.005-0.047 0.016-0.068 0.016-0.37 0.104-0.5 0.271-0.516 0.656-0.005 0.057 0 0.115 0 0.172-0.005 3.469 0 6.938-0.005 10.406 0 0.563-0.063 1.115-0.286 1.635-0.37 0.854-1.026 1.391-1.911 1.646-0.469 0.135-0.948 0.214-1.438 0.229-1.276 0.047-2.339-0.802-2.557-2.057-0.188-1.083 0.307-2.25 1.536-2.771 0.479-0.198 0.974-0.307 1.479-0.411 0.38-0.078 0.766-0.156 1.146-0.234 0.51-0.109 0.776-0.432 0.802-0.953v-0.198c0-3.948 0-7.896 0-11.844 0-0.167 0.021-0.333 0.057-0.495 0.094-0.38 0.365-0.599 0.729-0.688 0.339-0.089 0.688-0.151 1.031-0.224 0.979-0.198 1.953-0.396 2.932-0.589l3.026-0.615c0.896-0.177 1.786-0.359 2.682-0.536 0.292-0.057 0.589-0.12 0.885-0.141 0.411-0.036 0.698 0.224 0.74 0.641 0.010 0.099 0.016 0.198 0.016 0.297 0 2.547 0 5.094 0 7.641z"
      />
    </svg>
  );
}

function CoverArt({ coverUrl, artist, title, hex, alt }) {
  const resolved = coverUrl || null;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [resolved]);

  if (!resolved || failed) {
    return <PlaceholderCover artist={artist} title={title} hex={hex} />;
  }
  return <img src={resolved} alt={alt} onError={() => setFailed(true)} />;
}

function PlaceholderCover({ artist, title, hex }) {
  const initials = (artist || "?").slice(0, 1).toUpperCase();
  return (
    <div className="vc-placeholder" style={{ background: `linear-gradient(160deg, ${hex}26, #faf9f5)` }}>
      <span style={{ color: hex }}>{initials}</span>
    </div>
  );
}

// ================= DETAIL VIEW =================
function DetailView({ record, entryNo, canEdit, onBack, onEdit, onDelete, onLyrics, onSaveInfo, onMoveToCollection }) {
  const [revealed, setRevealed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState(false);
  const links = streamLinks(record.artist, record.title);

  useEffect(() => {
    const t = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(t);
  }, [record.id]);

  async function handleMoreInfo() {
    setInfoLoading(true);
    setInfoError(false);
    try {
      const text = await fetchAlbumStory(record.artist, record.title, record.year);
      onSaveInfo(text);
    } catch (e) {
      console.error(e);
      setInfoError(true);
    } finally {
      setInfoLoading(false);
    }
  }

  return (
    <main className="vc-detail">
      <button className="vc-back" onClick={onBack}>
        <ArrowLeft size={16} /> Back to vault
      </button>

      <div className="vc-detail-grid">
        <div className={`vc-stage ${revealed ? "is-revealed" : ""}`}>
          <div className="vc-stage-sleeve">
            <CoverArt coverUrl={record.coverUrl} artist={record.artist} title={record.title} hex={record.colorHex} alt={`${record.title} cover`} />
            {(() => {
              const badges = [...(record.specialTags || []), ...(record.vinylSize === "7\"" ? ["7\""] : [])];
              return badges.length > 0 ? <span className="vc-sleeve-highlight vc-stage-highlight">{badges.join(" · ")}</span> : null;
            })()}
          </div>
          <div className="vc-stage-disc">
            <DiscFace record={record} />
          </div>
        </div>

        <div className="vc-info">
          <p className="vc-eyebrow">
            No. {String(entryNo || 0).padStart(3, "0")}
            {record.version ? ` — ${record.version}` : " — Pressing"}
          </p>
          <h2>{record.title}</h2>
          <p className="vc-artist">{record.artist}</p>

          <div className="vc-meta-row">
            <span className="vc-mono">{record.year || "Year unknown"}</span>
            <span className="vc-dot-sep">·</span>
            <span className="vc-mono">{record.catalogNo || "No catalog #"}</span>
            <span className="vc-dot-sep">·</span>
            <span className="vc-color-tag">
              <span className="vc-chip-dot" style={{ background: record.colorHex }} />
              {record.colorLabel}
            </span>
            {record.finish && (
              <>
                <span className="vc-dot-sep">·</span>
                <span className="vc-color-tag">
                  <FinishIcon type={record.finish} size={15} />
                  {record.finish}
                </span>
              </>
            )}
            <span className="vc-dot-sep">·</span>
            <span className="vc-color-tag">
              <SizeIcon vinylSize={record.vinylSize || "12\""} size={15} />
              {record.vinylSize || "12\""}
            </span>
          </div>

          {(record.label || record.genre) && (
            <div className="vc-meta-row vc-meta-row-secondary">
              {record.label && <span className="vc-mono">{record.label}</span>}
              {record.label && record.genre && <span className="vc-dot-sep">·</span>}
              {record.genre && <span className="vc-mono">{record.genre}</span>}
            </div>
          )}

          {canEdit && record.status === "wishlist" && (
            <button className="vc-btn vc-btn-primary vc-move-btn" onClick={onMoveToCollection}>
              <CircleCheck size={15} /> Got it — move to Collection
            </button>
          )}

          <div className="vc-actions">
            <a className="vc-stream-btn" href={links.spotify} target="_blank" rel="noreferrer">
              <SpotifyIcon size={19} /> Spotify <ExternalLink size={12} className="vc-stream-ext" />
            </a>
            <a className="vc-stream-btn" href={links.ytmusic} target="_blank" rel="noreferrer">
              <YouTubeMusicIcon size={19} /> YouTube Music <ExternalLink size={12} className="vc-stream-ext" />
            </a>
            <a className="vc-stream-btn" href={links.apple} target="_blank" rel="noreferrer">
              <AppleMusicIcon size={19} /> Apple Music <ExternalLink size={12} className="vc-stream-ext" />
            </a>
          </div>

          {record.tracklist && record.tracklist.length > 0 && (
            <button className="vc-btn vc-btn-ghost" onClick={onLyrics}>
              <ListMusic size={15} /> Tracklist &amp; lyrics links
            </button>
          )}

          {(record.info || canEdit) && (
            <div className="vc-story">
              <div className="vc-story-head">
                <span>More info</span>
              </div>
              {canEdit && !record.info && !infoLoading && (
                <button className="vc-btn vc-btn-ghost" onClick={handleMoreInfo}>
                  Look up this album's story
                </button>
              )}
              {infoLoading && <p className="vc-muted">Searching the web for background…</p>}
              {infoError && <p className="vc-error">Couldn't fetch info — try again in a moment.</p>}
              {record.info && !infoLoading && (
                <>
                  <p className="vc-story-text">{record.info}</p>
                  {canEdit && (
                    <button className="vc-btn vc-btn-ghost vc-btn-sm" onClick={handleMoreInfo}>
                      Refresh
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {canEdit && (
            <div className="vc-manage-row">
              <button className="vc-btn vc-btn-ghost vc-btn-sm" onClick={onEdit}>
                <Pencil size={13} /> Edit details
              </button>
              {!confirmDelete ? (
                <button className="vc-btn vc-btn-ghost vc-btn-sm vc-danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={13} /> Remove from vault
                </button>
              ) : (
                <span className="vc-confirm">
                  Remove for good?
                  <button className="vc-btn vc-btn-sm vc-danger" onClick={onDelete}>Yes, remove</button>
                  <button className="vc-btn vc-btn-ghost vc-btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// ================= LYRICS VIEW =================
function LyricsView({ record, onBack }) {
  return (
    <main className="vc-detail">
      <button className="vc-back" onClick={onBack}>
        <ArrowLeft size={16} /> Back to {record.title}
      </button>
      <div className="vc-lyrics">
        <p className="vc-eyebrow">{record.artist}</p>
        <h2>{record.title} — tracklist</h2>
        <p className="vc-muted">
          Lyrics are licensed content, so they open on Genius instead of showing here. Tap a track to search it there.
        </p>
        <ol className="vc-tracklist">
          {record.tracklist.map((t, i) => (
            <li key={i}>
              <span className="vc-mono">{String(i + 1).padStart(2, "0")}</span>
              <span className="vc-track-name">{t}</span>
              <a href={geniusLink(record.artist, t)} target="_blank" rel="noreferrer" className="vc-track-link">
                Lyrics <ExternalLink size={12} />
              </a>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

// ================= FORM MODAL =================
function FormModal({ form, setForm, editing, onClose, onSubmit }) {
  const firstRef = useRef(null);
  const [formError, setFormError] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverError, setCoverError] = useState("");
  const coverPreview = form.coverUrl || null;
  const [discLoading, setDiscLoading] = useState(false);
  const [discError, setDiscError] = useState("");
  const discPreview = form.discImageUrl || null;
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState("");
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState("");
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleFetchLabelGenre() {
    if (!form.artist.trim() || !form.title.trim()) {
      setMetaError("Add the artist and album title first.");
      return;
    }
    setMetaError("");
    setMetaLoading(true);
    try {
      const { label, genre } = await fetchLabelGenre(form.artist, form.title, form.year);
      if (!label && !genre) throw new Error("Nothing found");
      setForm((f) => ({ ...f, label: label || f.label, genre: genre || f.genre }));
    } catch (err) {
      setMetaError("Couldn't find that online — you can still type it in.");
    } finally {
      setMetaLoading(false);
    }
  }

  async function handleFetchTracks() {
    if (!form.artist.trim() || !form.title.trim()) {
      setTrackError("Enter the artist and album title first.");
      return;
    }
    setTrackLoading(true);
    setTrackError("");
    try {
      const tracks = await fetchTracklist(form.artist, form.title, form.year);
      set("tracklist", formatNumberedList(tracks));
    } catch (e) {
      setTrackError("Couldn't find a tracklist online — you can still type it in below.");
    } finally {
      setTrackLoading(false);
    }
  }

  async function handleCoverFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setCoverError("");
    setCoverLoading(true);
    try {
      const dataUrl = await resizeImageFile(file);
      set("coverUrl", dataUrl);
    } catch (err) {
      setCoverError("Couldn't process that image — try a different file.");
    } finally {
      setCoverLoading(false);
    }
  }

  async function handleDiscFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setDiscError("");
    setDiscLoading(true);
    try {
      const dataUrl = await resizeImageFile(file);
      set("discImageUrl", dataUrl);
    } catch (err) {
      setDiscError("Couldn't process that image — try a different file.");
    } finally {
      setDiscLoading(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.artist.trim() || !form.title.trim()) {
      setFormError("Add both an artist and an album title before saving.");
      return;
    }
    setFormError("");
    onSubmit(e);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
      handleSubmit(e);
    }
  }

  return (
    <div className="vc-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vc-modal" onKeyDown={handleKeyDown}>
        <div className="vc-modal-head">
          <h3>{editing ? "Edit record" : "Add a record"}</h3>
          <button type="button" className="vc-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="vc-form-grid">
          <label className="vc-field">
            <span>Artist *</span>
            <input ref={firstRef} value={form.artist} onChange={(e) => set("artist", e.target.value)} />
          </label>
          <label className="vc-field">
            <span>Album title *</span>
            <input value={form.title} onChange={(e) => set("title", e.target.value)} />
          </label>
          <label className="vc-field">
            <span>Year</span>
            <input inputMode="numeric" value={form.year} onChange={(e) => set("year", e.target.value)} placeholder="1979" />
          </label>
          <label className="vc-field">
            <span>Version / pressing</span>
            <input value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="180g reissue, 2019" />
          </label>
          <label className="vc-field">
            <span>Catalog #</span>
            <input value={form.catalogNo} onChange={(e) => set("catalogNo", e.target.value)} placeholder="e.g. label pressing code" />
          </label>

          <div className="vc-field vc-field-wide">
            <span className="vc-field-label-row">
              Label &amp; genre
              <button type="button" className="vc-btn vc-btn-ghost vc-btn-sm" onClick={handleFetchLabelGenre} disabled={metaLoading}>
                <Wand2 size={13} />
                {metaLoading ? "Searching the web…" : "Auto-fill from the web"}
              </button>
            </span>
            <div className="vc-cover-row">
              <input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="Record label, e.g. Columbia Records" />
              <input value={form.genre} onChange={(e) => set("genre", e.target.value)} placeholder="Genre, e.g. Pop, Electropop" />
            </div>
            {metaError && <p className="vc-error">{metaError}</p>}
          </div>

          <div className="vc-field vc-field-wide">
            <span>Cover image</span>
            <div className="vc-cover-row">
              <input
                value={form.coverUrl && form.coverUrl.startsWith("local:") ? "" : form.coverUrl}
                onChange={(e) => set("coverUrl", e.target.value)}
                placeholder={form.coverUrl && form.coverUrl.startsWith("local:") ? "Using an uploaded photo — type here to use a URL instead" : "Paste an image URL…"}
              />
              <label className={`vc-btn vc-btn-outline vc-btn-sm vc-upload-btn ${coverLoading ? "is-disabled" : ""}`}>
                <Upload size={13} />
                {coverLoading ? "Processing…" : "Upload from computer"}
                <input type="file" accept="image/*" onChange={handleCoverFile} disabled={coverLoading} hidden />
              </label>
            </div>
            {coverError && <p className="vc-error">{coverError}</p>}
            {coverPreview && (
              <div className="vc-cover-preview">
                <img src={coverPreview} alt="Cover preview" />
                <button type="button" className="vc-btn vc-btn-ghost vc-btn-sm" onClick={() => set("coverUrl", "")}>
                  Remove cover
                </button>
              </div>
            )}
          </div>

          <div className="vc-field vc-field-wide">
            <span>Record image (optional — for picture discs or custom art)</span>
            <div className="vc-cover-row">
              <input
                value={form.discImageUrl && form.discImageUrl.startsWith("localdisc:") ? "" : form.discImageUrl}
                onChange={(e) => set("discImageUrl", e.target.value)}
                placeholder={form.discImageUrl && form.discImageUrl.startsWith("localdisc:") ? "Using an uploaded photo — type here to use a URL instead" : "Paste an image of the record itself…"}
              />
              <label className={`vc-btn vc-btn-outline vc-btn-sm vc-upload-btn ${discLoading ? "is-disabled" : ""}`}>
                <Upload size={13} />
                {discLoading ? "Processing…" : "Upload from computer"}
                <input type="file" accept="image/*" onChange={handleDiscFile} disabled={discLoading} hidden />
              </label>
            </div>
            {discError && <p className="vc-error">{discError}</p>}
            {discPreview && (
              <div className="vc-disc-position">
                <div className="vc-disc-position-preview">
                  <img
                    className="vc-disc-position-img"
                    src={discPreview}
                    alt="Record preview"
                    style={{
                      objectPosition: `${form.discImageX}% ${form.discImageY}%`,
                      transform: `scale(${(form.discImageZoom || 100) / 100})`,
                    }}
                  />
                  <span className="vc-disc-position-mask" />
                </div>
                <div className="vc-disc-position-controls">
                  <label className="vc-slider-row">
                    <span>Zoom</span>
                    <input
                      type="range"
                      min="100"
                      max="280"
                      value={form.discImageZoom}
                      onChange={(e) => set("discImageZoom", Number(e.target.value))}
                    />
                  </label>
                  <label className="vc-slider-row">
                    <span>Shift left / right</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={form.discImageX}
                      onChange={(e) => set("discImageX", Number(e.target.value))}
                    />
                  </label>
                  <label className="vc-slider-row">
                    <span>Shift up / down</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={form.discImageY}
                      onChange={(e) => set("discImageY", Number(e.target.value))}
                    />
                  </label>
                  <p className="vc-hint">The shaded side stays hidden behind the sleeve — zoom in a bit, then nudge until the part you want visible sits in the clear zone.</p>
                  <button type="button" className="vc-btn vc-btn-ghost vc-btn-sm" onClick={() => set("discImageUrl", "")}>
                    Remove image
                  </button>
                </div>
              </div>
            )}
            <p className="vc-hint">Leave this blank and the record will just show its color instead.</p>
          </div>

          <div className="vc-field vc-field-color">
            <span>Vinyl color</span>
            <div className="vc-color-row">
              <input
                type="color"
                value={form.colorHex}
                onChange={(e) => set("colorHex", e.target.value)}
              />
              <input
                className="vc-color-label"
                value={form.colorLabel}
                onChange={(e) => set("colorLabel", e.target.value)}
                placeholder="Clear with red splatter"
              />
            </div>
            <div className="vc-presets">
              {COLOR_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  className="vc-preset-dot"
                  style={{ background: p.hex }}
                  title={p.label}
                  onClick={() => {
                    set("colorHex", p.hex);
                    set("colorLabel", p.label);
                  }}
                />
              ))}
            </div>
          </div>

          <div className="vc-field vc-field-wide">
            <span>Finish</span>
            <div className="vc-finish-grid">
              {FINISH_OPTIONS.map((f) => (
                <button
                  type="button"
                  key={f}
                  className={`vc-finish-option ${form.finish === f ? "is-active" : ""}`}
                  onClick={() => set("finish", f)}
                  title={f}
                >
                  <FinishIcon type={f} />
                  <span>{f}</span>
                </button>
              ))}
            </div>
            <p className="vc-hint">
              Color + finish together give the full picture — e.g. <em>Blue</em> / <em>Translucent</em>, or <em>Black</em> / <em>Splatter</em>.
            </p>
          </div>

          <div className="vc-field vc-field-wide">
            <span>Highlights (optional — combine with any finish above)</span>
            <div className="vc-finish-grid">
              {SPECIAL_TAGS.map((tag) => {
                const active = form.specialTags.includes(tag);
                return (
                  <button
                    type="button"
                    key={tag}
                    className={`vc-finish-option ${active ? "is-active" : ""}`}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        specialTags: active ? f.specialTags.filter((t) => t !== tag) : [...f.specialTags, tag],
                      }))
                    }
                    title={tag}
                  >
                    <FinishIcon type={tag} />
                    <span>{tag}</span>
                  </button>
                );
              })}
            </div>
            <p className="vc-hint">A Signed, Limited pressing can also be Splatter, Transparent, or any other finish.</p>
          </div>

          <div className="vc-field vc-field-wide">
            <span>Size</span>
            <div className="vc-size-toggle">
              {VINYL_SIZES.map((s) => (
                <button
                  type="button"
                  key={s}
                  className={`vc-finish-option ${form.vinylSize === s ? "is-active" : ""}`}
                  onClick={() => set("vinylSize", s)}
                >
                  <SizeIcon vinylSize={s} />
                  <span>{s}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="vc-field vc-field-wide">
            <span className="vc-field-label-row">
              Tracklist (for the lyrics page)
              <button type="button" className="vc-btn vc-btn-ghost vc-btn-sm" onClick={handleFetchTracks} disabled={trackLoading}>
                <Wand2 size={13} />
                {trackLoading ? "Searching the web…" : "Auto-fill from the web"}
              </button>
            </span>
            <textarea
              rows={5}
              value={form.tracklist}
              onChange={(e) => set("tracklist", e.target.value)}
              placeholder={"1. Track one\n2. Track two\n3. Track three"}
            />
            {trackError && <p className="vc-error">{trackError}</p>}
          </label>

          <label className="vc-field vc-field-wide">
            <span>Album story (optional — paste text you've generated elsewhere)</span>
            <textarea
              rows={4}
              value={form.info || ""}
              onChange={(e) => set("info", e.target.value)}
              placeholder="Background, context, interesting facts about this pressing…"
            />
          </label>
        </div>

        <div className="vc-modal-actions">
          {formError && <p className="vc-error vc-form-error">{formError}</p>}
          <button type="button" className="vc-btn vc-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="vc-btn vc-btn-primary" onClick={handleSubmit}>
            {editing ? "Save changes" : "Add to vault"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ================= STYLES =================
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

.vc-root {
  --ink: #201e1a;
  --ink-soft: #6b6558;
  --paper: #f5f3ee;
  --panel: #ffffff;
  --panel-2: #ffffff;
  --line: #ddd7c8;
  --accent: #33415c;
  --accent-tint: #33415c14;
  --rust: #93463a;
  --radius: 8px;
  font-family: 'Inter', sans-serif;
  background: var(--paper);
  color: var(--ink);
  min-height: 100%;
  padding: 30px 34px 64px;
  box-sizing: border-box;
}
.vc-root * { box-sizing: border-box; }
.vc-mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.82em; color: var(--ink-soft); }

.vc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 20px;
  margin-bottom: 30px;
  border-bottom: 1px solid var(--line);
}
.vc-brand { display: flex; align-items: center; gap: 12px; }
.vc-brand-icon { color: var(--accent); }
.vc-brand h1 {
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  font-size: 1.35rem;
  margin: 0;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.vc-brand p {
  margin: 2px 0 0;
  font-size: 0.72rem;
  color: var(--ink-soft);
  font-family: 'IBM Plex Mono', monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.vc-header-actions { display: flex; align-items: center; gap: 16px; }
.vc-tally {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.72rem;
  color: var(--ink-soft);
  letter-spacing: 0.03em;
}

.vc-tabs { display: flex; gap: 6px; margin-bottom: 22px; border-bottom: 1px solid var(--line); }
.vc-tab {
  background: transparent; border: none; border-bottom: 2px solid transparent;
  padding: 10px 4px 12px; margin-right: 22px; cursor: pointer;
  font-size: 0.92rem; font-weight: 500; color: var(--ink-soft);
  display: flex; align-items: center; gap: 8px;
}
.vc-tab:hover { color: var(--ink); }
.vc-tab.is-active { color: var(--ink); border-bottom-color: var(--accent); }
.vc-tab-count {
  font-family: 'IBM Plex Mono', monospace; font-size: 0.7rem; color: var(--ink-soft);
  background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
}
.vc-tab.is-active .vc-tab-count { color: var(--accent); border-color: var(--accent); }

.vc-move-btn { margin-bottom: 14px; }

.vc-history-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
@media (max-width: 700px) { .vc-history-grid { grid-template-columns: repeat(2, 1fr); } }
.vc-history-tile {
  position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; padding: 0;
  background: var(--panel); border: 1px solid var(--line); cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.vc-history-tile:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 14px 24px -16px #00000030; }
.vc-history-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vc-history-badge {
  position: absolute; bottom: 8px; left: 8px;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; letter-spacing: 0.04em; text-transform: uppercase;
  background: #f5f3eee6; color: var(--ink-soft); padding: 3px 7px; border-radius: 3px; backdrop-filter: blur(2px);
}

.vc-fab {
  position: fixed; bottom: 30px; right: 30px; z-index: 40;
  width: 54px; height: 54px; border-radius: 50%;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 12px 26px -8px #00000030; cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.vc-fab:hover { transform: translateY(-2px); border-color: var(--accent); color: var(--accent); }
.vc-share-modal {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius);
  width: 100%; max-width: 520px; max-height: 88vh; overflow-y: auto; padding: 24px 26px;
  box-shadow: 0 30px 60px -20px #00000040;
}
.vc-share-preview { width: 100%; display: block; border-radius: 8px; margin: 14px 0; border: 1px solid var(--line); }

.vc-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  padding: 9px 16px;
  border-radius: var(--radius);
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  text-decoration: none;
}
.vc-btn:hover { border-color: var(--accent); color: var(--accent); }
.vc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.vc-btn:disabled:hover { border-color: var(--line); color: var(--ink); }
.vc-btn-primary { background: var(--accent); color: #fbfaf7; border-color: var(--accent); font-weight: 600; }
.vc-btn-primary:hover { background: #405070; color: #fff; }
.vc-btn-outline { background: transparent; }
.vc-btn-ghost { background: transparent; border-color: transparent; padding: 8px 4px; color: var(--ink-soft); }
.vc-btn-ghost:hover { color: var(--accent); background: transparent; }
.vc-btn-sm { padding: 6px 10px; font-size: 0.76rem; }
.vc-danger { color: var(--rust); }
.vc-icon-btn {
  display: inline-flex; align-items: center; gap: 4px;
  background: transparent; border: 1px solid var(--line); color: var(--ink-soft);
  border-radius: 6px; padding: 8px 10px; cursor: pointer; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem;
}
.vc-icon-btn:hover { color: var(--accent); border-color: var(--accent); }

.vc-toolbar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; align-items: center; }
.vc-search {
  display: flex; align-items: center; gap: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 9px 14px; flex: 1 1 260px; color: var(--ink-soft);
}
.vc-search input { background: transparent; border: none; outline: none; color: var(--ink); width: 100%; font-size: 0.85rem; font-family: 'Inter', sans-serif; }
.vc-sort { display: flex; gap: 8px; align-items: center; }
.vc-sort select {
  background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px;
  padding: 8px 10px; font-size: 0.8rem; font-family: 'Inter', sans-serif;
}

.vc-chip-group { margin-bottom: 14px; }
.vc-chip-group-label {
  display: block; font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ink-soft); margin-bottom: 8px;
}
.vc-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.vc-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--panel); border: 1px solid var(--line); color: var(--ink-soft);
  border-radius: 5px; padding: 6px 12px; font-size: 0.74rem; cursor: pointer;
  text-transform: uppercase; letter-spacing: 0.03em;
}
.vc-chip.is-active { border-color: var(--accent); color: var(--accent); background: var(--accent-tint); }
.vc-chip-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; border: 1px solid #0002; }

.vc-warning { background: #f3e3de; border: 1px solid var(--rust); color: #6e2c22; padding: 10px 14px; border-radius: 6px; font-size: 0.82rem; margin-bottom: 16px; }

.vc-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 90px 20px; color: var(--ink-soft); text-align: center;
}
.vc-empty h3 { font-family: 'Spectral', serif; color: var(--ink); margin: 0; font-size: 1.2rem; font-weight: 500; }
.vc-spin-slow { animation: vc-spin 3s linear infinite; color: var(--accent); }

.vc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(172px, 200px));
  gap: 34px 72px;
}
.vc-sleeve {
  background: transparent; border: none; padding: 0; cursor: pointer; text-align: left;
  color: var(--ink); display: flex; flex-direction: column; gap: 9px;
  animation: vc-rise 0.5s ease both;
  animation-delay: calc(var(--i) * 35ms);
}
.vc-sleeve-stage { position: relative; aspect-ratio: 1; }
.vc-sleeve-cover {
  position: absolute; inset: 0; z-index: 2; border-radius: 4px; overflow: hidden;
  background: var(--panel); border: 1px solid var(--line);
  box-shadow: 0 1px 2px #0000000d;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.vc-sleeve:hover .vc-sleeve-cover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 14px 24px -16px #00000030; }
.vc-sleeve-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vc-sleeve-disc {
  position: absolute; top: 6%; right: 0; width: 88%; height: 88%; border-radius: 50%;
  z-index: 1; opacity: 0; transform: translateX(0);
  transition: transform 0.6s cubic-bezier(.16,1,.3,1), opacity 0.4s ease;
  box-shadow: 0 12px 22px -14px #00000045;
}
.vc-sleeve:hover .vc-sleeve-disc { opacity: 1; transform: translateX(38%); }
.vc-sleeve-no {
  position: absolute; top: 8px; left: 8px; z-index: 3;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; letter-spacing: 0.04em;
  background: #f5f3eee6; color: var(--ink-soft); padding: 3px 6px; border-radius: 3px;
  backdrop-filter: blur(2px);
}
.vc-sleeve-highlight {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; letter-spacing: 0.05em; text-transform: uppercase;
  background: var(--accent); color: #fbfaf7; padding: 3px 7px; border-radius: 3px;
  box-shadow: 0 2px 6px -2px #00000050;
}
.vc-stage-highlight { top: 12px; right: 12px; font-size: 0.66rem; padding: 4px 9px; }
.vc-disc-face {
  position: absolute; inset: 0; border-radius: 50%; overflow: hidden;
}
.vc-disc-face-img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
.vc-disc-face-plain { display: flex; align-items: center; justify-content: center; }
.vc-disc-label {
  position: absolute; inset: 38% 38% 38% 38%; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #00000022 inset;
}
.vc-disc-hole { width: 22%; height: 22%; border-radius: 50%; background: var(--paper); box-shadow: 0 0 0 1px #00000022 inset; }
.vc-placeholder {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  font-family: 'Spectral', serif; font-size: 2.6rem;
}
.vc-sleeve-meta { display: flex; flex-direction: column; gap: 1px; }
.vc-sleeve-meta strong { font-size: 0.87rem; line-height: 1.25; font-weight: 500; }
.vc-sleeve-meta span { font-size: 0.76rem; color: var(--ink-soft); }

.vc-back {
  display: inline-flex; align-items: center; gap: 6px; background: transparent; border: none;
  color: var(--ink-soft); cursor: pointer; font-size: 0.83rem; margin-bottom: 26px; padding: 0;
}
.vc-back:hover { color: var(--accent); }

.vc-detail-grid { display: grid; grid-template-columns: minmax(240px, 340px) 1fr; gap: 100px; align-items: start; }
@media (max-width: 900px) { .vc-detail-grid { grid-template-columns: 1fr; gap: 32px; } }

.vc-stage { position: relative; aspect-ratio: 1; }
.vc-stage-sleeve {
  position: absolute; inset: 0; border-radius: 5px; overflow: hidden; background: var(--panel);
  border: 1px solid var(--line); box-shadow: 0 20px 40px -24px #00000040; z-index: 2;
}
.vc-stage-sleeve img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vc-stage-disc {
  position: absolute; top: 6%; right: 0; width: 88%; height: 88%; border-radius: 50%;
  z-index: 1; transform: translateX(0) rotate(0deg); opacity: 0;
  transition: transform 1.1s cubic-bezier(.16,1,.3,1), opacity 0.6s ease;
  box-shadow: 0 18px 34px -20px #00000038;
}
.vc-stage.is-revealed .vc-stage-disc {
  transform: translateX(24%) rotate(360deg);
  opacity: 1;
  animation: vc-record-spin 26s linear infinite;
  animation-delay: 1.1s;
}
.vc-stage-label {
  position: absolute; inset: 38% 38% 38% 38%; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #00000022 inset;
}
.vc-stage-hole { width: 14%; height: 14%; background: var(--paper); border-radius: 50%; }
.vc-stage-disc .vc-disc-face { border-radius: 50%; overflow: hidden; }
.vc-stage-disc .vc-disc-label { inset: 38% 38% 38% 38%; }
.vc-stage-disc .vc-disc-hole { width: 14%; height: 14%; }

.vc-info { padding-top: 4px; position: relative; z-index: 4; background: var(--paper); }
.vc-eyebrow { font-family: 'IBM Plex Mono', monospace; color: var(--accent); font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 8px; }
.vc-info h2 { font-family: 'Spectral', serif; font-weight: 500; font-size: 2rem; margin: 0 0 4px; line-height: 1.15; }
.vc-artist { font-size: 1.02rem; color: var(--ink-soft); margin: 0 0 16px; font-style: italic; font-family: 'Spectral', serif; }
.vc-meta-row { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
.vc-meta-row-secondary { margin-top: -14px; }
.vc-dot-sep { color: var(--line); }
.vc-color-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; }

.vc-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.vc-stream-btn {
  display: inline-flex; align-items: center; gap: 9px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 999px;
  padding: 9px 16px 9px 12px; font-size: 0.85rem; font-weight: 500; color: var(--ink);
  text-decoration: none; transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.vc-stream-btn:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: 0 8px 16px -10px #00000030; }
.vc-stream-ext { color: var(--ink-soft); margin-left: 2px; }

.vc-story { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 18px; }
.vc-story-head { display: flex; align-items: center; gap: 6px; color: var(--accent); font-size: 0.76rem; font-family: 'IBM Plex Mono', monospace; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
.vc-story-text { font-size: 0.92rem; line-height: 1.6; color: var(--ink); margin: 0 0 10px; }
.vc-muted { color: var(--ink-soft); font-size: 0.85rem; }
.vc-error { color: var(--rust); font-size: 0.85rem; }

.vc-manage-row { display: flex; gap: 10px; align-items: center; margin-top: 22px; border-top: 1px solid var(--line); padding-top: 16px; flex-wrap: wrap; }
.vc-confirm { display: flex; gap: 6px; align-items: center; font-size: 0.8rem; color: var(--ink-soft); }

.vc-lyrics { max-width: 640px; }
.vc-lyrics h2 { font-family: 'Spectral', serif; font-weight: 500; margin: 0 0 10px; }
.vc-tracklist { list-style: none; padding: 0; margin: 22px 0 0; display: flex; flex-direction: column; }
.vc-tracklist li { display: flex; align-items: center; gap: 14px; padding: 13px 4px; border-bottom: 1px solid var(--line); }
.vc-track-name { flex: 1; font-size: 0.92rem; }
.vc-track-link { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; font-size: 0.78rem; font-family: 'IBM Plex Mono', monospace; }
.vc-track-link:hover { text-decoration: underline; }

.vc-overlay {
  position: fixed; inset: 0; background: #201e1acc; backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 50;
  animation: vc-fade 0.15s ease;
}
.vc-modal {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius);
  width: 100%; max-width: 640px; max-height: 88vh; overflow-y: auto; padding: 26px 28px;
  box-shadow: 0 30px 60px -20px #00000040;
  animation: vc-pop 0.2s cubic-bezier(.2,.8,.2,1);
}
.vc-modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.vc-modal-head h3 { font-family: 'Spectral', serif; font-weight: 500; margin: 0; font-size: 1.25rem; }
.vc-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
.vc-field { display: flex; flex-direction: column; gap: 6px; font-size: 0.76rem; color: var(--ink-soft); }
.vc-field input, .vc-field textarea, .vc-field select {
  background: var(--paper); border: 1px solid var(--line); border-radius: 6px; color: var(--ink);
  padding: 9px 11px; font-size: 0.87rem; font-family: 'Inter', sans-serif;
}
.vc-field input:focus, .vc-field textarea:focus, .vc-field select:focus { outline: none; border-color: var(--accent); }
.vc-field-wide { grid-column: 1 / -1; }
.vc-field-color { grid-column: 1 / -1; }
.vc-cover-row { display: flex; gap: 10px; }
.vc-cover-row input { flex: 1; }
.vc-upload-btn {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  cursor: pointer; flex-shrink: 0;
}
.vc-upload-btn.is-disabled { opacity: 0.6; cursor: not-allowed; }
.vc-cover-preview {
  display: flex; align-items: center; gap: 12px; margin-top: 10px;
}
.vc-cover-preview img {
  width: 56px; height: 56px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line);
}
.vc-disc-position { display: flex; gap: 16px; align-items: flex-start; margin-top: 10px; flex-wrap: wrap; }
.vc-disc-position-preview {
  position: relative; width: 108px; height: 108px; border-radius: 50%; overflow: hidden;
  flex-shrink: 0; box-shadow: 0 0 0 1px var(--line);
}
.vc-disc-position-img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block; transform-origin: center center;
}
.vc-disc-position-mask {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, #00000094 0%, #00000094 60%, transparent 63%, transparent 100%);
}
.vc-disc-position-controls { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 9px; }
.vc-slider-row { display: flex; align-items: center; gap: 10px; font-size: 0.76rem; color: var(--ink-soft); }
.vc-slider-row span { width: 96px; flex-shrink: 0; }
.vc-slider-row input[type=range] { flex: 1; accent-color: var(--accent); }
.vc-disc-position-controls .vc-btn { align-self: flex-start; }
.vc-field-hint { justify-content: flex-end; }
.vc-hint { margin: 0; font-size: 0.76rem; color: var(--ink-soft); line-height: 1.5; }
.vc-hint em { color: var(--accent); font-style: normal; }
.vc-field-label-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.vc-field-label-row .vc-btn { padding: 5px 9px; font-size: 0.72rem; }
.vc-color-row { display: flex; gap: 10px; }
.vc-color-row input[type=color] { width: 44px; height: 38px; padding: 2px; border-radius: 6px; border: 1px solid var(--line); background: var(--paper); }
.vc-color-label { flex: 1; }
.vc-presets { display: flex; gap: 8px; margin-top: 8px; }
.vc-preset-dot { width: 19px; height: 19px; border-radius: 50%; border: 1px solid #00000022; cursor: pointer; }

.vc-size-toggle { display: flex; gap: 8px; margin-top: 4px; }
.vc-size-toggle .vc-finish-option { width: 84px; }

.vc-finish-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 8px;
  margin-top: 4px;
}
.vc-finish-option {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  background: var(--paper); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 6px; cursor: pointer; color: var(--ink-soft);
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.vc-finish-option svg { color: var(--ink-soft); transition: color 0.15s ease; }
.vc-finish-option span { font-size: 0.65rem; text-align: center; line-height: 1.25; }
.vc-finish-option:hover { border-color: var(--accent); color: var(--accent); }
.vc-finish-option:hover svg { color: var(--accent); }
.vc-finish-option.is-active { border-color: var(--accent); background: var(--accent-tint); color: var(--accent); }
.vc-finish-option.is-active svg { color: var(--accent); }
.vc-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; align-items: center; }
.vc-form-error { margin: 0 auto 0 0; }

@keyframes vc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes vc-pop { from { opacity: 0; transform: scale(0.96) translateY(6px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes vc-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes vc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes vc-record-spin { from { transform: translateX(24%) rotate(0deg); } to { transform: translateX(24%) rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .vc-sleeve, .vc-sleeve-disc, .vc-stage-disc, .vc-spin-slow { animation: none !important; transition: none !important; }
}
`;
