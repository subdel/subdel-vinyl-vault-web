import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Plus, X, ArrowLeft, Search, ArrowUpDown, Disc3, ExternalLink, ListMusic, Trash2, Pencil, Upload, CircleCheck, Share, Download, Sun, Moon, QrCode, GripVertical, ChevronLeft, ChevronRight, BarChart3, FileDown } from "lucide-react";
import { supabase } from "./supabaseClient";
import QRCode from "qrcode";
import { motion, useMotionValue, useSpring } from "motion/react";
import { Camera, Mesh, Plane, Program, Renderer, Texture, Transform } from "ogl";

const FINISH_OPTIONS = [
  "Standard (opaque)",
  "Transparent",
  "Translucent",
  "Splatter",
  "Split",
  "Marble / Swirl",
  "Glitter",
  "Picture disc",
  "Zoetrope",
  "Etching",
  "Glow in the dark",
];

// Finishes where the whole surface IS the artwork — a single "vinyl color"
// doesn't apply, so the color field is hidden/cleared and excluded from
// filters and stats. (Etching is NOT here: etched records still have a color.)
const finishHidesColor = (f) => f === "Picture disc" || f === "Zoetrope";

// Highlights are additive — a record can be Splatter AND Signed AND Limited at once.
const SPECIAL_TAGS = ["Signed", "Limited"];
const NEW_BADGE_DAYS = 3;
const isRecentlyAdded = (r) => Date.now() - (r.addedAt || 0) < NEW_BADGE_DAYS * 24 * 60 * 60 * 1000;
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
  extraDiscs: [],
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
    extraDiscs: Array.isArray(row.extra_discs) ? row.extra_discs : [],
    tracklist: row.tracklist || [],
    info: row.info || null,
    addedAt: Number(row.added_at) || Date.now(),
    sortOrder: row.sort_order != null ? Number(row.sort_order) : Number(row.added_at) || Date.now(),
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
    extra_discs: rec.extraDiscs || [],
    tracklist: rec.tracklist || [],
    info: rec.info || null,
    added_at: rec.addedAt || Date.now(),
    sort_order: rec.sortOrder ?? rec.addedAt ?? Date.now(),
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

async function generateCollectionImage(records, sortBy = "added") {
  const ordered =
    sortBy === "color"
      ? [...records].sort((a, b) => (a.colorLabel || "").localeCompare(b.colorLabel || "") || a.addedAt - b.addedAt)
      : [...records].sort((a, b) => a.addedAt - b.addedAt);
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


// ================= APP =================
export default function VinylCrate() {
  const [records, setRecords] = useState(null); // null = loading
  const [view, setView] = useState("grid"); // grid | detail | lyrics
  const [selectedId, setSelectedId] = useState(null);

  // ---- hash routing: #/record/<id> and #/record/<id>/lyrics ----
  const gridScrollRef = useRef(0);
  useEffect(() => {
    function applyHash() {
      const m = window.location.hash.match(/^#\/record\/([^/]+)(\/lyrics)?$/);
      if (m) {
        setSelectedId(decodeURIComponent(m[1]));
        setView(m[2] ? "lyrics" : "detail");
        // record pages always start from the top
        requestAnimationFrame(() => window.scrollTo(0, 0));
      } else {
        setSelectedId(null);
        setView("grid");
        // returning to the grid: put the user back where they were
        requestAnimationFrame(() => window.scrollTo(0, gridScrollRef.current));
      }
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  const openRecord = (id) => {
    gridScrollRef.current = window.scrollY;
    window.location.hash = `/record/${encodeURIComponent(id)}`;
  };
  const openLyrics = (id) => { window.location.hash = `/record/${encodeURIComponent(id)}/lyrics`; };
  const goHome = () => {
    // strip the hash without leaving a "#" behind
    history.pushState("", document.title, window.location.pathname + window.location.search);
    setSelectedId(null);
    setView("grid");
    requestAnimationFrame(() => window.scrollTo(0, gridScrollRef.current));
  };
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
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  const [theme, setTheme] = useState(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("vv-theme") : null;
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    localStorage.setItem("vv-theme", theme);
    const bg = theme === "dark" ? "#16151a" : "#f5f3ee";
    document.documentElement.style.background = bg;
    document.body.style.background = bg;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);


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
    const ordered = [...scopedRecords].sort((a, b) =>
      sortField === "sortOrder"
        ? (a.sortOrder ?? a.addedAt) - (b.sortOrder ?? b.addedAt)
        : a.addedAt - b.addedAt
    );
    const map = {};
    ordered.forEach((r, i) => (map[r.id] = i + 1));
    return map;
  }, [scopedRecords, sortField]);

  const distinctColors = useMemo(() => {
    if (!scopedRecords) return [];
    const map = new Map();
    scopedRecords.forEach((r) => {
      if (r.colorLabel && !finishHidesColor(r.finish) && !map.has(r.colorLabel)) map.set(r.colorLabel, r.colorHex);
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
      list = list.filter((r) => r.colorLabel === colorFilter && !finishHidesColor(r.finish));
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
      if (sortField === "year" || sortField === "addedAt" || sortField === "sortOrder") {
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
      extraDiscs: rec.extraDiscs || [],
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
      const extraDiscsField = await Promise.all(
        (form.extraDiscs || []).map(async (d, idx) => {
          if (d.discImageUrl && d.discImageUrl.startsWith("data:")) {
            const url = await uploadImageToStorage(d.discImageUrl, `disc-${recId}-extra${idx}-${Date.now()}.jpg`);
            return { ...d, discImageUrl: url };
          }
          return d;
        })
      );

      const extraDiscsNormalized = extraDiscsField.map((d) =>
        finishHidesColor(d.finish) ? { ...d, colorLabel: "", colorHex: "" } : d
      );

      const rec = {
        ...form,
        id: recId,
        tracklist,
        coverUrl: coverField,
        discImageUrl: discField,
        extraDiscs: extraDiscsNormalized,
        colorLabel: finishHidesColor(form.finish) ? "" : form.colorLabel,
        colorHex: finishHidesColor(form.finish) ? "" : form.colorHex,
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
      setToast(editingId ? "Changes saved" : form.status === "wishlist" ? "Added to wishlist" : "Added to vault");
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
      goHome();
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

  async function handleReorder(draggedId, targetId, visibleList) {
    if (draggedId === targetId) return;
    const list = [...visibleList];
    const draggedIdx = list.findIndex((r) => r.id === draggedId);
    const targetIdx = list.findIndex((r) => r.id === targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    const [moved] = list.splice(draggedIdx, 1);
    const afterRemovalTargetIdx = list.findIndex((r) => r.id === targetId);
    const insertAt = draggedIdx < targetIdx ? afterRemovalTargetIdx + 1 : afterRemovalTargetIdx;
    list.splice(insertAt, 0, moved);

    const movedIdx = list.findIndex((r) => r.id === draggedId);
    const prev = list[movedIdx - 1];
    const next = list[movedIdx + 1];
    const prevOrder = prev ? prev.sortOrder ?? prev.addedAt : null;
    const nextOrder = next ? next.sortOrder ?? next.addedAt : null;
    let newOrder;
    if (prevOrder != null && nextOrder != null) {
      newOrder = (prevOrder + nextOrder) / 2;
    } else if (prevOrder != null) {
      newOrder = prevOrder + 1000;
    } else if (nextOrder != null) {
      newOrder = nextOrder - 1000;
    } else {
      newOrder = Date.now();
    }

    setRecords(records.map((r) => (r.id === draggedId ? { ...r, sortOrder: newOrder } : r)));
    try {
      await updateRecordDb(draggedId, { ...records.find((r) => r.id === draggedId), sortOrder: newOrder });
    } catch (err) {
      console.error("Couldn't reorder", err);
      setSaveError(true);
    }
  }

  return (
    <div className="vc-root" data-theme={theme}>
      <style>{CSS}</style>
      <ClickSpark sparkColor={theme === "dark" ? "#ffffff" : "#33415c"}>

      <div className="vc-nav-glass">
        <header className="vc-header">
          <div className="vc-brand">
            <Disc3 className="vc-brand-icon" size={24} strokeWidth={1.3} />
            <div>
              <h1>Sub Del's Vinyl Vault</h1>
              <p>Collection archive</p>
            </div>
          </div>
          <div className="vc-header-actions">
            {view === "grid" && activeTab !== "history" && activeTab !== "insights" && activeTab !== "about" && scopedRecords && scopedRecords.length > 0 && (
              <span className="vc-tally">{scopedRecords.length} {activeTab === "wishlist" ? "wanted" : "pressing"}{scopedRecords.length === 1 ? "" : "s"}</span>
            )}
            {view === "grid" && activeTab !== "history" && activeTab !== "insights" && activeTab !== "about" && (
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
            <button
              className="vc-theme-toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              <span className={`vc-theme-thumb ${theme === "dark" ? "is-dark" : ""}`}>
                {theme === "dark" ? <Moon size={12} /> : <Sun size={12} />}
              </span>
            </button>
          </div>
        </header>

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
            <button
              className={`vc-tab ${activeTab === "insights" ? "is-active" : ""}`}
              onClick={() => switchTab("insights")}
            >
              Insights
            </button>
            <button
              className={`vc-tab ${activeTab === "about" ? "is-active" : ""}`}
              onClick={() => switchTab("about")}
            >
              About
            </button>
          </nav>
        )}
      </div>

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}

      {toast && (
        <div className="vc-toast" role="status">
          <svg className="vc-toast-check" viewBox="0 0 24 24" width="18" height="18">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path className="vc-toast-tick" d="M7.5 12.4l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {toast}
        </div>
      )}


      {view === "grid" && activeTab === "history" && (
        <HistoryView
          loading={records === null}
          records={records || []}
          onOpen={openRecord}
        />
      )}

      {view === "grid" && activeTab === "insights" && (
        <InsightsView records={records || []} />
      )}

      {view === "grid" && activeTab === "about" && <AboutView records={records} theme={theme} />}

      {view === "grid" && activeTab !== "history" && activeTab !== "insights" && activeTab !== "about" && (
        <GridView
          loading={records === null}
          records={filtered}
          total={scopedRecords ? scopedRecords.length : 0}
          activeTab={activeTab}
          canEdit={!!session}
          onReorder={(draggedId, targetId) => handleReorder(draggedId, targetId, filtered)}
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
          onOpen={openRecord}
          onAdd={openAdd}
          saveError={saveError}
        />
      )}

      {view === "detail" && selected && (
        <DetailView
          record={selected}
          entryNo={entryNumbers[selected.id]}
          canEdit={!!session}
          onBack={goHome}
          onEdit={() => openEdit(selected)}
          onDelete={() => deleteRecord(selected.id)}
          onLyrics={() => openLyrics(selected.id)}
          onMoveToCollection={() => moveToCollection(selected.id)}
        />
      )}

      {view === "lyrics" && selected && (
        <LyricsView record={selected} onBack={() => openRecord(selected.id)} />
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
      </ClickSpark>
    </div>
  );
}

// ================= GRID VIEW =================
// ================= HISTORY (4-column grid of everything ever added) =================
function InsightsView({ records }) {
  const owned = useMemo(() => records.filter((r) => (r.status || "owned") === "owned"), [records]);

  const stats = useMemo(() => {
    const count = (getKeys) => {
      const map = new Map();
      owned.forEach((r) => {
        getKeys(r).forEach((k) => {
          if (!k) return;
          map.set(k, (map.get(k) || 0) + 1);
        });
      });
      return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    };
    return {
      colors: count((r) => [finishHidesColor(r.finish) ? null : r.colorLabel]).slice(0, 8),
      colorHexes: Object.fromEntries(owned.filter((r) => r.colorLabel).map((r) => [r.colorLabel, r.colorHex])),
      years: count((r) => [r.year]).slice(0, 8),
      genres: count((r) => (r.genre || "").split(",").map((g) => g.trim())).slice(0, 8),
      artists: count((r) => [r.artist]).slice(0, 8),
      sizes: count((r) => [r.vinylSize || '12"']),
      finishes: count((r) => [r.finish]).slice(0, 8),
      discTotal: owned.reduce((t, r) => t + 1 + (r.extraDiscs ? r.extraDiscs.length : 0), 0),
    };
  }, [owned]);

  function exportCsv() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["No", "Artist", "Title", "Year", "Version", "Catalog #", "Label", "Genre", "Color", "Finish", "Size", "Discs", "Highlights", "Status", "Added"];
    const ordered = [...records].sort((a, b) => a.addedAt - b.addedAt);
    const rows = ordered.map((r, i) => [
      i + 1, r.artist, r.title, r.year, r.version, r.catalogNo, r.label, r.genre,
      r.colorLabel, r.finish, r.vinylSize || '12"',
      1 + (r.extraDiscs ? r.extraDiscs.length : 0),
      (r.specialTags || []).join("; "),
      r.status || "owned",
      new Date(r.addedAt).toISOString().slice(0, 10),
    ].map(esc).join(","));
    const csv = [header.map(esc).join(","), ...rows].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vinyl-vault-collection.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function StatBlock({ title, entries, dots }) {
    if (!entries.length) return null;
    const max = entries[0][1];
    return (
      <div className="vc-insight-block">
        <h3>{title}</h3>
        {entries.map(([label, n]) => (
          <div key={label} className="vc-insight-row">
            <span className="vc-insight-label">
              {dots && stats.colorHexes[label] && <span className="vc-chip-dot" style={{ background: stats.colorHexes[label] }} />}
              {label}
            </span>
            <span className="vc-insight-bar-track">
              <span className="vc-insight-bar" style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <span className="vc-insight-n">{n}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <main className="vc-main">
      <div className="vc-insights-head">
        <div className="vc-insight-totals">
          <div className="vc-insight-total"><strong>{owned.length}</strong><span>pressings</span></div>
          <div className="vc-insight-total"><strong>{stats.discTotal}</strong><span>discs total</span></div>
          <div className="vc-insight-total"><strong>{stats.artists.length}</strong><span>artists (top shown)</span></div>
        </div>
        <button className="vc-btn vc-btn-outline" onClick={exportCsv}>
          <FileDown size={15} /> Export CSV
        </button>
      </div>
      {owned.length === 0 ? (
        <div className="vc-empty"><p>Add some records and your collection insights will appear here.</p></div>
      ) : (
        <div className="vc-insights-grid">
          <StatBlock title="Colors" entries={stats.colors} dots />
          <StatBlock title="Genres" entries={stats.genres} />
          <StatBlock title="Top artists" entries={stats.artists} />
          <StatBlock title="Years" entries={stats.years} />
          <StatBlock title="Finishes" entries={stats.finishes} />
          <StatBlock title="Sizes" entries={stats.sizes} />
        </div>
      )}
    </main>
  );
}

// ================= TILTED COVER (3D hover tilt for the Collection grid) =================
// Adapted from React Bits <TiltedCard />: takes children (CoverArt handles its own
// placeholder fallback) instead of a bare imageSrc, and follows the site's tokens.
const TILT_SPRING = { damping: 30, stiffness: 100, mass: 2 };
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function TiltedCover({ children, overlay = null, caption = "", rotateAmplitude = 12, scaleOnHover = 1.07 }) {
  const ref = useRef(null);
  const lastY = useRef(0);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useSpring(useMotionValue(0), TILT_SPRING);
  const rotateY = useSpring(useMotionValue(0), TILT_SPRING);
  const scale = useSpring(1, TILT_SPRING);
  const opacity = useSpring(0);
  const rotateCaption = useSpring(0, { stiffness: 350, damping: 30, mass: 1 });

  function handleMouse(e) {
    if (!ref.current || prefersReducedMotion()) return;
    const rect = ref.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left - rect.width / 2;
    const offsetY = e.clientY - rect.top - rect.height / 2;

    rotateX.set((offsetY / (rect.height / 2)) * -rotateAmplitude);
    rotateY.set((offsetX / (rect.width / 2)) * rotateAmplitude);

    x.set(e.clientX - rect.left);
    y.set(e.clientY - rect.top);

    const velocityY = offsetY - lastY.current;
    rotateCaption.set(-velocityY * 0.6);
    lastY.current = offsetY;
  }

  function handleMouseEnter() {
    if (prefersReducedMotion()) return;
    scale.set(scaleOnHover);
    opacity.set(1);
  }

  function handleMouseLeave() {
    opacity.set(0);
    scale.set(1);
    rotateX.set(0);
    rotateY.set(0);
    rotateCaption.set(0);
  }

  return (
    <div
      ref={ref}
      className="vc-tilt-figure"
      onMouseMove={handleMouse}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <motion.div className="vc-tilt-inner" style={{ rotateX, rotateY, scale }}>
        {children}
        {overlay && <motion.div className="vc-tilt-overlay">{overlay}</motion.div>}
      </motion.div>
      {caption && (
        <motion.div className="vc-tilt-caption" style={{ x, y, opacity, rotate: rotateCaption }}>
          {caption}
        </motion.div>
      )}
    </div>
  );
}

// ================= CLICK SPARK (spark burst on every click, sitewide) =================
// Adapted from React Bits <ClickSpark />.
function ClickSpark({
  sparkColor = "#fff",
  sparkSize = 10,
  sparkRadius = 18,
  sparkCount = 8,
  duration = 420,
  easing = "ease-out",
  extraScale = 1.0,
  children,
}) {
  const canvasRef = useRef(null);
  const sparksRef = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    let resizeTimeout;
    const resizeCanvas = () => {
      const { width, height } = parent.getBoundingClientRect();
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(resizeCanvas, 100);
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(parent);
    resizeCanvas();

    return () => {
      ro.disconnect();
      clearTimeout(resizeTimeout);
    };
  }, []);

  const easeFunc = useCallback(
    (t) => {
      switch (easing) {
        case "linear":
          return t;
        case "ease-in":
          return t * t;
        case "ease-in-out":
          return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        default:
          return t * (2 - t);
      }
    },
    [easing]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let animationId;

    const draw = (timestamp) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sparksRef.current = sparksRef.current.filter((spark) => {
        const elapsed = timestamp - spark.startTime;
        if (elapsed >= duration) return false;

        const progress = elapsed / duration;
        const eased = easeFunc(progress);
        const distance = eased * sparkRadius * extraScale;
        const lineLength = sparkSize * (1 - eased);

        const x1 = spark.x + distance * Math.cos(spark.angle);
        const y1 = spark.y + distance * Math.sin(spark.angle);
        const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle);
        const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle);

        ctx.strokeStyle = sparkColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        return true;
      });
      animationId = requestAnimationFrame(draw);
    };
    animationId = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(animationId);
  }, [sparkColor, sparkSize, sparkRadius, duration, easeFunc, extraScale]);

  const handleClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas || prefersReducedMotion()) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const now = performance.now();
    const newSparks = Array.from({ length: sparkCount }, (_, i) => ({
      x,
      y,
      angle: (2 * Math.PI * i) / sparkCount,
      startTime: now,
    }));
    sparksRef.current.push(...newSparks);
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }} onClick={handleClick}>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          userSelect: "none",
          position: "absolute",
          top: 0,
          left: 0,
          pointerEvents: "none",
          zIndex: 90,
        }}
      />
      {children}
    </div>
  );
}

// ================= CIRCULAR GALLERY (WebGL cover carousel, A→Z by artist) =================
// Adapted from React Bits <CircularGallery />: square planes (record sleeves),
// full-color textures, right-to-left autoplay, events scoped to the container
// so page scrolling is never hijacked.
function galleryLerp(p1, p2, t) {
  return p1 + (p2 - p1) * t;
}

function createGalleryTextTexture(gl, text, font, color) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = font;
  const metrics = context.measureText(text);
  const sizeMatch = font.match(/(\d+)px/);
  const fontSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 26;
  canvas.width = Math.ceil(metrics.width) + 20;
  canvas.height = Math.ceil(fontSize * 1.2) + 20;
  context.font = font;
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new Texture(gl, { generateMipmaps: false });
  texture.image = canvas;
  return { texture, width: canvas.width, height: canvas.height };
}

class GalleryTitle {
  constructor({ gl, plane, text, textColor, font }) {
    this.gl = gl;
    this.plane = plane;
    const { texture, width, height } = createGalleryTextTexture(gl, text, font, textColor);
    const geometry = new Plane(gl);
    const program = new Program(gl, {
      vertex: `
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragment: `
        precision highp float;
        uniform sampler2D tMap;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(tMap, vUv);
          if (color.a < 0.1) discard;
          gl_FragColor = color;
        }
      `,
      uniforms: { tMap: { value: texture } },
      transparent: true,
    });
    this.mesh = new Mesh(gl, { geometry, program });
    const aspect = width / height;
    // Child of the plane: scale/position are fractions of the parent, so this
    // stays correct no matter when the plane itself gets resized.
    const textHeight = 0.12;
    this.mesh.scale.set(textHeight * aspect, textHeight, 1);
    this.mesh.position.y = -0.5 - textHeight * 0.5 - 0.05;
    this.mesh.setParent(plane);
  }
}

class GalleryMedia {
  constructor({ geometry, gl, image, index, length, scene, screen, text, viewport, bend, textColor, borderRadius, font }) {
    this.extra = 0;
    this.geometry = geometry;
    this.gl = gl;
    this.image = image;
    this.index = index;
    this.length = length;
    this.scene = scene;
    this.screen = screen;
    this.text = text;
    this.viewport = viewport;
    this.bend = bend;
    this.textColor = textColor;
    this.borderRadius = borderRadius;
    this.font = font;
    this.createShader();
    this.createMesh();
    this.title = new GalleryTitle({ gl, plane: this.plane, text, textColor, font });
    this.onResize();
  }
  createShader() {
    const texture = new Texture(this.gl, { generateMipmaps: true });
    this.program = new Program(this.gl, {
      depthTest: false,
      depthWrite: false,
      vertex: `
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        uniform float uTime;
        uniform float uSpeed;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          p.z = (sin(p.x * 4.0 + uTime) * 1.5 + cos(p.y * 2.0 + uTime) * 1.5) * (0.1 + uSpeed * 0.5);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragment: `
        precision highp float;
        uniform vec2 uImageSizes;
        uniform vec2 uPlaneSizes;
        uniform sampler2D tMap;
        uniform float uBorderRadius;
        varying vec2 vUv;
        float roundedBoxSDF(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b;
          return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - r;
        }
        void main() {
          vec2 ratio = vec2(
            min((uPlaneSizes.x / uPlaneSizes.y) / (uImageSizes.x / uImageSizes.y), 1.0),
            min((uPlaneSizes.y / uPlaneSizes.x) / (uImageSizes.y / uImageSizes.x), 1.0)
          );
          vec2 uv = vec2(
            vUv.x * ratio.x + (1.0 - ratio.x) * 0.5,
            vUv.y * ratio.y + (1.0 - ratio.y) * 0.5
          );
          vec4 color = texture2D(tMap, uv);
          float d = roundedBoxSDF(vUv - 0.5, vec2(0.5 - uBorderRadius), uBorderRadius);
          float alpha = 1.0 - smoothstep(-0.002, 0.002, d);
          gl_FragColor = vec4(color.rgb, alpha);
        }
      `,
      uniforms: {
        tMap: { value: texture },
        uPlaneSizes: { value: [0, 0] },
        uImageSizes: { value: [0, 0] },
        uSpeed: { value: 0 },
        uTime: { value: 100 * Math.random() },
        uBorderRadius: { value: this.borderRadius },
      },
      transparent: true,
    });
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = this.image;
    img.onload = () => {
      texture.image = img;
      this.program.uniforms.uImageSizes.value = [img.naturalWidth, img.naturalHeight];
    };
  }
  createMesh() {
    this.plane = new Mesh(this.gl, { geometry: this.geometry, program: this.program });
    this.plane.setParent(this.scene);
  }
  update(scroll, direction) {
    this.plane.position.x = this.x - scroll.current - this.extra;
    const x = this.plane.position.x;
    const H = this.viewport.width / 2;
    if (this.bend === 0) {
      this.plane.position.y = this.yLift || 0;
      this.plane.rotation.z = 0;
    } else {
      const B_abs = Math.abs(this.bend);
      const R = (H * H + B_abs * B_abs) / (2 * B_abs);
      const effectiveX = Math.min(Math.abs(x), H);
      const arc = R - Math.sqrt(R * R - effectiveX * effectiveX);
      if (this.bend > 0) {
        this.plane.position.y = -arc;
        this.plane.rotation.z = -Math.sign(x) * Math.asin(effectiveX / R);
      } else {
        this.plane.position.y = arc;
        this.plane.rotation.z = Math.sign(x) * Math.asin(effectiveX / R);
      }
    }
    this.speed = scroll.current - scroll.last;
    this.program.uniforms.uTime.value += 0.04;
    this.program.uniforms.uSpeed.value = this.speed;

    const planeOffset = this.plane.scale.x / 2;
    const viewportOffset = this.viewport.width / 2;
    this.isBefore = this.plane.position.x + planeOffset < -viewportOffset;
    this.isAfter = this.plane.position.x - planeOffset > viewportOffset;
    if (direction === "right" && this.isBefore) {
      this.extra -= this.widthTotal;
      this.isBefore = this.isAfter = false;
    }
    if (direction === "left" && this.isAfter) {
      this.extra += this.widthTotal;
      this.isBefore = this.isAfter = false;
    }
  }
  onResize({ screen, viewport } = {}) {
    if (screen) this.screen = screen;
    if (viewport) this.viewport = viewport;
    // Square planes: same pixel side for width and height — record sleeves.
    this.scale = this.screen.height / 1500;
    const sidePx = 860 * this.scale;
    this.plane.scale.y = (this.viewport.height * sidePx) / this.screen.height;
    this.plane.scale.x = (this.viewport.width * sidePx) / this.screen.width;
    this.plane.program.uniforms.uPlaneSizes.value = [this.plane.scale.x, this.plane.scale.y];
    // Lift covers a bit above center so the label below never clips.
    this.yLift = this.plane.scale.y * 0.09;
    this.padding = 1.4;
    this.width = this.plane.scale.x + this.padding;
    this.widthTotal = this.width * this.length;
    this.x = this.width * this.index;
  }
}

class GalleryEngine {
  constructor(container, { items, bend, textColor, borderRadius, font, scrollSpeed, scrollEase, autoplaySpeed }) {
    this.container = container;
    this.scrollSpeed = scrollSpeed;
    this.autoplaySpeed = autoplaySpeed;
    this.scroll = { ease: scrollEase, current: 0, target: 0, last: 0 };
    this.isDown = false;
    this.createRenderer();
    this.createCamera();
    this.scene = new Transform();
    this.onResize();
    this.planeGeometry = new Plane(this.gl, { heightSegments: 50, widthSegments: 100 });
    this.createMedias(items, bend, textColor, borderRadius, font);
    this.update = this.update.bind(this);
    this.raf = window.requestAnimationFrame(this.update);
    this.addEventListeners();
  }
  createRenderer() {
    this.renderer = new Renderer({ alpha: true, antialias: true, dpr: Math.min(window.devicePixelRatio || 1, 2) });
    this.gl = this.renderer.gl;
    this.gl.clearColor(0, 0, 0, 0);
    this.container.appendChild(this.gl.canvas);
  }
  createCamera() {
    this.camera = new Camera(this.gl);
    this.camera.fov = 45;
    this.camera.position.z = 20;
  }
  createMedias(items, bend, textColor, borderRadius, font) {
    this.mediasImages = items.concat(items);
    this.medias = this.mediasImages.map(
      (data, index) =>
        new GalleryMedia({
          geometry: this.planeGeometry,
          gl: this.gl,
          image: data.image,
          index,
          length: this.mediasImages.length,
          scene: this.scene,
          screen: this.screen,
          text: data.text,
          viewport: this.viewport,
          bend,
          textColor,
          borderRadius,
          font,
        })
    );
  }
  onTouchDown(e) {
    this.isDown = true;
    this.scroll.position = this.scroll.current;
    this.start = e.touches ? e.touches[0].clientX : e.clientX;
  }
  onTouchMove(e) {
    if (!this.isDown) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    this.scroll.target = this.scroll.position + (this.start - x) * (this.scrollSpeed * 0.025);
  }
  onTouchUp() {
    this.isDown = false;
  }
  onKeyDown(e) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.scroll.target += this.scrollSpeed * 3;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.scroll.target -= this.scrollSpeed * 3;
    }
  }
  onResize() {
    this.screen = { width: this.container.clientWidth, height: this.container.clientHeight };
    this.renderer.setSize(this.screen.width, this.screen.height);
    this.camera.perspective({ aspect: this.screen.width / this.screen.height });
    const fov = (this.camera.fov * Math.PI) / 180;
    const height = 2 * Math.tan(fov / 2) * this.camera.position.z;
    this.viewport = { width: height * this.camera.aspect, height };
    if (this.medias) {
      this.medias.forEach((media) => media.onResize({ screen: this.screen, viewport: this.viewport }));
    }
  }
  update() {
    // Autoplay: constant right-to-left drift, paused while the user drags.
    if (!this.isDown && this.autoplaySpeed) {
      this.scroll.target += this.autoplaySpeed;
    }
    this.scroll.current = galleryLerp(this.scroll.current, this.scroll.target, this.scroll.ease);
    const direction = this.scroll.current > this.scroll.last ? "right" : "left";
    if (this.medias) this.medias.forEach((media) => media.update(this.scroll, direction));
    this.renderer.render({ scene: this.scene, camera: this.camera });
    this.scroll.last = this.scroll.current;
    this.raf = window.requestAnimationFrame(this.update);
  }
  addEventListeners() {
    this.boundResize = this.onResize.bind(this);
    this.boundDown = this.onTouchDown.bind(this);
    this.boundMove = this.onTouchMove.bind(this);
    this.boundUp = this.onTouchUp.bind(this);
    this.boundKey = this.onKeyDown.bind(this);
    window.addEventListener("resize", this.boundResize);
    // Drag starts on the gallery itself; move/up on window so the drag
    // survives leaving the container. No wheel listeners — the page keeps
    // its normal scroll behaviour.
    this.container.addEventListener("mousedown", this.boundDown);
    window.addEventListener("mousemove", this.boundMove);
    window.addEventListener("mouseup", this.boundUp);
    this.container.addEventListener("touchstart", this.boundDown, { passive: true });
    this.container.addEventListener("touchmove", this.boundMove, { passive: true });
    this.container.addEventListener("touchend", this.boundUp);
    this.container.addEventListener("keydown", this.boundKey);
  }
  destroy() {
    window.cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.boundResize);
    this.container.removeEventListener("mousedown", this.boundDown);
    window.removeEventListener("mousemove", this.boundMove);
    window.removeEventListener("mouseup", this.boundUp);
    this.container.removeEventListener("touchstart", this.boundDown);
    this.container.removeEventListener("touchmove", this.boundMove);
    this.container.removeEventListener("touchend", this.boundUp);
    this.container.removeEventListener("keydown", this.boundKey);
    if (this.gl && this.gl.canvas.parentNode) {
      this.gl.canvas.parentNode.removeChild(this.gl.canvas);
    }
  }
}

function CircularGallery({
  items,
  bend = 2,
  textColor = "#c3cadd",
  borderRadius = 0.04,
  font = '500 26px "IBM Plex Mono"',
  scrollSpeed = 2,
  scrollEase = 0.06,
  autoplaySpeed = 0.03,
}) {
  const containerRef = useRef(null);
  useEffect(() => {
    if (!containerRef.current || !items || !items.length) return;
    let engine;
    let mounted = true;
    const init = async () => {
      try {
        if (document.fonts && document.fonts.load) {
          await document.fonts.load(font);
        }
      } catch {
        /* fall back to whatever the browser provides */
      }
      if (!mounted || !containerRef.current) return;
      engine = new GalleryEngine(containerRef.current, {
        items,
        bend,
        textColor,
        borderRadius,
        font,
        scrollSpeed,
        scrollEase,
        autoplaySpeed: prefersReducedMotion() ? 0 : autoplaySpeed,
      });
    };
    init();
    return () => {
      mounted = false;
      if (engine) engine.destroy();
    };
  }, [items, bend, textColor, borderRadius, font, scrollSpeed, scrollEase, autoplaySpeed]);
  return (
    <div
      className="vc-circular-gallery"
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label="Record covers gallery, A to Z by artist. Drag or use arrow keys to browse."
    />
  );
}

// ================= ABOUT ME =================
function AboutView({ records, theme }) {
  const rootRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > 30) setScrolled(true);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // All covers, alphabetically by artist (then title): Aerosmith → Lady Gaga → …
  const galleryItems = useMemo(() => {
    if (!records) return [];
    return [...records]
      .filter((r) => r.coverUrl)
      .sort(
        (a, b) =>
          (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" }) ||
          (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" })
      )
      .map((r) => ({ image: r.coverUrl, text: `${r.artist} — ${r.title}` }));
  }, [records]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks = root.querySelectorAll(".vc-essay-block");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("is-visible");
            io.unobserve(en.target);
          }
        });
      },
      { threshold: 0.2 }
    );
    blocks.forEach((b) => io.observe(b));
    return () => io.disconnect();
  }, []);

  return (
    <main className="vc-main vc-essay" ref={rootRef}>
      {/* HERO */}
      <section className="vc-essay-block vc-essay-hero">
        <p className="vc-essay-eyebrow">About</p>
        <h2>Through Sound.</h2>
        <p className="vc-essay-sub">A personal archive told through vinyl.</p>
        <div className={`vc-essay-scrollhint ${scrolled ? "is-hidden" : ""}`} aria-hidden="true">
          Scroll
          <span className="vc-essay-scrollhint-arrow">↓</span>
        </div>
      </section>

      {/* 01 — WHY MUSIC */}
      <section className="vc-essay-block">
        <p className="vc-essay-eyebrow">01 — Why music</p>
        <h3>
          Each record in this collection is a mirror.
          <br />
          In it, I see myself.
        </h3>
        <p>
          Music has always been more than something I listen to. It is how I experience
          emotions, remember people, and relive moments. Some days it brings calm, others
          it brings energy. Sometimes it helps me slow down, sometimes it reminds me where
          I've been.
        </p>
        <p className="vc-essay-accent">For me, music is how life sounds.</p>
      </section>

      {/* 02 — WHY VINYL */}
      <section className="vc-essay-block">
        <p className="vc-essay-eyebrow">02 — Why vinyl</p>
        <h3>Vinyl is different.</h3>
        <p>
          Not because it sounds "better", but because it asks you to slow down. Holding a
          record in your hands feels like holding an artifact. Every sleeve, every
          pressing, every small imperfection becomes part of the experience.
        </p>
        <p className="vc-essay-accent">
          Streaming gives access to music.
          <br />
          Vinyl gives me a relationship with it.
        </p>
        <p>
          I love owning an album, listening to it from beginning to end, exactly as the
          artist intended. Sometimes collecting is about discovering something rare. Most
          of the time, it's about preserving something meaningful.
        </p>
      </section>

      {/* 03 — WHERE IT BEGAN */}
      <section className="vc-essay-block">
        <p className="vc-essay-eyebrow">03 — Where it began</p>
        <h3>Everything started in 2023.</h3>
        <p>A colleague gave me my first record as a gift:</p>
        <p className="vc-essay-record">Sade — Diamond Life</p>
        <p>
          I didn't know it then, but that single record became the beginning of something
          much bigger.
        </p>
        <p className="vc-essay-accent">
          Not simply a collection.
          <br />
          A timeline.
        </p>
      </section>

      {/* 04 — WHAT I COLLECT */}
      <section className="vc-essay-block">
        <p className="vc-essay-eyebrow">04 — What I collect</p>
        <h3>Every album here has earned its place.</h3>
        <p>I don't collect records for the sake of collecting.</p>
        <p>
          Some remind me of a specific period of my life. Some belong to artists who have
          shaped me. Some are rare pressings I searched for over months. Others simply
          make me feel something every time the needle drops.
        </p>
        <p className="vc-essay-accent">
          This collection is built on emotion before rarity.
          <br />
          Meaning before quantity.
        </p>
      </section>

      {/* 05 — THE ARCHIVE */}
      <section className="vc-essay-block">
        <p className="vc-essay-eyebrow">05 — The archive</p>
        <h3>This website began as a way to catalogue my collection.</h3>
        <p>Over time it became something else.</p>
        <p>
          A place to preserve memories. A place to share music that has shaped me. A place
          I hope I'll come back to years from now.
        </p>
        <p className="vc-essay-accent">
          To see my life...
          <br />
          through sound.
        </p>
      </section>

      {/* GALLERY — the archive drifting by, A to Z */}
      {galleryItems.length > 0 && (
        <section className="vc-essay-block vc-essay-gallery-block">
          <p className="vc-essay-eyebrow vc-essay-gallery-label">The archive — A to Z</p>
          <div className="vc-essay-gallery">
            <CircularGallery
              items={galleryItems}
              bend={0}
              textColor={theme === "dark" ? "#c3cadd" : "#33415c"}
              borderRadius={0.04}
              font={'500 26px "IBM Plex Mono"'}
            />
          </div>
        </section>
      )}

      {/* CLOSING */}
      <section className="vc-essay-block vc-essay-closing">
        <div className="vc-essay-closing-text">
          <h3>Sub Del</h3>
          <p className="vc-essay-sig">
            Attention to detail.
            <br />
            Curiosity.
            <br />
            Nostalgia.
          </p>
          <p className="vc-essay-sig-final">Pressed into vinyl.</p>
        </div>
        <img
          className="vc-about-photo"
          src="/about-me.webp"
          alt="Sub Del holding records from the collection"
          loading="lazy"
        />
      </section>
    </main>
  );
}

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
        <div className="vc-history-grid">
          {ordered.map((r) => (
            <button key={r.id} className="vc-history-tile vc-history-tile-tilt" onClick={() => onOpen(r.id)} aria-label={`${r.title} — ${r.artist}`}>
              <TiltedCover
                overlay={
                  <>
                    <span className="vc-tilt-chip">{r.artist}</span>
                    {r.status === "wishlist" && <span className="vc-history-badge">Wishlist</span>}
                    {isRecentlyAdded(r) && <span className="vc-history-badge vc-history-badge-new">New</span>}
                  </>
                }
              >
                <CoverArt coverUrl={r.coverUrl} artist={r.artist} title={r.title} hex={r.colorHex} alt={`${r.title} cover`} />
              </TiltedCover>
            </button>
          ))}
        </div>
      )}
      {!loading && ordered.length > 0 && <ShareCollectionButton records={ordered} />}
      {!loading && <QRCodeButton />}
    </main>
  );
}

function QRCodeButton() {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState("");
  const link = typeof window !== "undefined" ? window.location.origin : "";

  async function handleClick() {
    setOpen(true);
    setError("");
    try {
      const url = await QRCode.toDataURL(link, {
        width: 480,
        margin: 2,
        color: { dark: "#201e1a", light: "#f5f3ee" },
      });
      setDataUrl(url);
    } catch (e) {
      console.error(e);
      setError("Couldn't generate the QR code.");
    }
  }

  return (
    <>
      <button className="vc-fab vc-fab-secondary" onClick={handleClick} title="QR code for this vault">
        <QrCode size={20} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="vc-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="vc-share-modal" style={{ maxWidth: 420, textAlign: "center" }}>
            <div className="vc-modal-head">
              <h3 className="vc-title-brand">Scan to view</h3>
              <button type="button" className="vc-icon-btn" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </div>
            {error && <p className="vc-error">{error}</p>}
            {dataUrl && <img src={dataUrl} alt="QR code" style={{ width: "100%", maxWidth: 320, margin: "0 auto", display: "block", borderRadius: 8 }} />}
            <p className="vc-mono" style={{ marginTop: 14, wordBreak: "break-all" }}>{link}</p>
          </div>
        </div>
      )}
    </>
  );
}

function LoginModal({ onClose }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => localStorage.getItem("vv-remember") !== "0");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    localStorage.setItem("vv-remember", remember ? "1" : "0");
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError("Couldn't sign in — check your email and password.");
    } else {
      onClose();
    }
  }

  return (
    <div className="vc-overlay">
      <div className="vc-modal" style={{ maxWidth: 380 }}>
        <div className="vc-modal-head">
          <h3 className="vc-title-brand">Sign in</h3>
          <button type="button" className="vc-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label className="vc-field">
            <span>Email</span>
            <input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="vc-field">
            <span>Password</span>
            <input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <label className="vc-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Remember me on this device</span>
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
  const [sortBy, setSortBy] = useState("added");

  async function generate(sort) {
    setLoading(true);
    setError("");
    try {
      const res = await generateCollectionImage(records, sort);
      setResult(res);
    } catch (e) {
      console.error(e);
      setError("Couldn't generate the image — try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleClick() {
    setOpen(true);
    setResult(null);
    generate(sortBy);
  }

  function handleSortChange(next) {
    setSortBy(next);
    generate(next);
  }

  async function handleDownload() {
    if (!result) return;
    try {
      const blob = await (await fetch(result.dataUrl)).blob();
      const file = new File([blob], "my-collection.png", { type: "image/png" });
      // iOS Safari: a[download] on data URLs silently does nothing — use the
      // native share sheet (lets the user pick "Save Image") when available.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-collection.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      // User dismissed the share sheet — not an error, do nothing.
      if (e && e.name === "AbortError") return;
      // Last resort: open the image in a new tab so it can be long-press saved.
      window.open(result.dataUrl, "_blank");
    }
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
              <h3 className="vc-title-brand">Share your collection</h3>
              <button type="button" className="vc-icon-btn" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="vc-share-sort">
              <span>Sort by</span>
              <div className="vc-chips">
                <button
                  className={`vc-chip ${sortBy === "added" ? "is-active" : ""}`}
                  onClick={() => handleSortChange("added")}
                  disabled={loading}
                >
                  Added order
                </button>
                <button
                  className={`vc-chip ${sortBy === "color" ? "is-active" : ""}`}
                  onClick={() => handleSortChange("color")}
                  disabled={loading}
                >
                  Color
                </button>
              </div>
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
  onReorder,
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
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const dragEnabled = canEdit && sortField === "sortOrder";

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
          <select
            value={sortField}
            onChange={(e) => {
              setSortField(e.target.value);
              if (e.target.value === "sortOrder") setSortDir("asc");
            }}
          >
            <option value="addedAt">Added order</option>
            <option value="sortOrder">My order (drag to arrange)</option>
            <option value="artist">Artist</option>
            <option value="title">Album title</option>
            <option value="year">Year</option>
            <option value="colorLabel">Vinyl color</option>
            <option value="finish">Finish</option>
            <option value="version">Version</option>
          </select>
          {sortField !== "sortOrder" && (
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
          )}
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

      {dragEnabled && (
        <div className="vc-drag-hint">
          <GripVertical size={13} /> Drag any cover to arrange your shelf your way.
        </div>
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
              className={`vc-sleeve ${dragEnabled ? "is-draggable" : ""} ${dragOverId === r.id ? "is-drag-over" : ""}`}
              style={{ "--i": i, opacity: draggedId === r.id ? 0.35 : 1 }}
              draggable={dragEnabled}
              onDragStart={(e) => {
                if (!dragEnabled) return;
                setDraggedId(r.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!dragEnabled) return;
                e.preventDefault();
                if (dragOverId !== r.id) setDragOverId(r.id);
              }}
              onDragLeave={() => {
                if (dragOverId === r.id) setDragOverId(null);
              }}
              onDrop={(e) => {
                if (!dragEnabled) return;
                e.preventDefault();
                if (draggedId) onReorder(draggedId, r.id);
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              onClick={() => {
                if (!draggedId) onOpen(r.id);
              }}
            >
              {dragEnabled && (
                <span className="vc-reorder-controls">
                  <button
                    type="button"
                    className="vc-reorder-btn"
                    title="Move earlier"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (i > 0) onReorder(r.id, records[i - 1].id);
                    }}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="vc-drag-handle-inline" title="Drag to reorder">
                    <GripVertical size={13} />
                  </span>
                  <button
                    type="button"
                    className="vc-reorder-btn"
                    title="Move later"
                    disabled={i === records.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (i < records.length - 1) onReorder(r.id, records[i + 1].id);
                    }}
                  >
                    <ChevronRight size={14} />
                  </button>
                </span>
              )}
              <span className="vc-sleeve-stage">
                <span className="vc-sleeve-cover">
                  <CoverArt coverUrl={r.coverUrl} artist={r.artist} title={r.title} hex={r.colorHex} alt={`${r.title} cover`} />
                  <span className="vc-sleeve-no">
                    No. {String(entryNumbers[r.id] || 0).padStart(3, "0")}
                  </span>
                  {isRecentlyAdded(r) && <span className="vc-sleeve-new">NEW</span>}
                  {(() => {
                    const badges = [...(r.specialTags || []), ...(r.vinylSize === "7\"" ? ["7\""] : [])];
                    return badges.length > 0 ? <span className="vc-sleeve-highlight">{badges.join(" · ")}</span> : null;
                  })()}
                </span>
                <span className="vc-sleeve-disc">
                  <DiscStack record={r} />
                </span>
              </span>
              <span className="vc-sleeve-meta">
                <strong>{r.title}</strong>
                <span>{r.artist}</span>
                <span className="vc-mono">
                  {r.year || "—"}
                  {r.extraDiscs && r.extraDiscs.length > 0 ? ` · ${r.extraDiscs.length + 1}× vinyl` : ""}
                </span>
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
    case "Zoetrope":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.85" />
          <path
            d="M24.5 16H28M22 22l2.5 2.5M16 24.5V28M10 22l-2.5 2.5M7.5 16H4M10 10L7.5 7.5M16 7.5V4M22 10l2.5-2.5"
            stroke="var(--paper)" strokeWidth="1.3" strokeLinecap="round"
          />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
        </svg>
      );
    case "Etching":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.85" />
          <path
            d="M8.5 11.5c2 1.4 4-1.4 6 0M7.5 16c2 1.4 3.5-1.4 5.5 0M8.5 20.5c2 1.4 4-1.4 6 0"
            stroke="var(--paper)" strokeWidth="1" fill="none" strokeLinecap="round"
          />
          <circle cx="16" cy="16" r="3" fill="var(--paper)" />
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
  const fallbackHex = record.colorHex || "#8a857a";
  return (
    <span
      className="vc-disc-face vc-disc-face-plain"
      style={{ background: `radial-gradient(circle at 50% 50%, transparent 0 18%, ${fallbackHex} 19% 46%, transparent 47% 48%, ${fallbackHex} 49% 100%)` }}
    >
      <span className="vc-disc-label" style={{ background: fallbackHex }}>
        <span className="vc-disc-hole" />
      </span>
    </span>
  );
}

function DiscStack({ record, spread = 20 }) {
  const extras = record.extraDiscs || [];
  const discs = [
    {
      colorHex: record.colorHex,
      finish: record.finish,
      discImageUrl: record.discImageUrl,
      discImageX: record.discImageX,
      discImageY: record.discImageY,
      discImageZoom: record.discImageZoom,
    },
    ...extras,
  ];
  const n = discs.length;
  return (
    <>
      {discs.map((d, i) => {
        // Back disc (i = n-1) travels the container's full distance (offset 0);
        // each disc in front trails left in equal steps, never exceeding the single-disc bound.
        const offset = n > 1 ? ((i - (n - 1)) / (n - 1)) * spread : 0;
        return (
          <span
            key={i}
            className="vc-disc-layer"
            style={{ "--disc-offset": `${offset}%`, zIndex: n - i }}
          >
            <DiscFace record={d} />
          </span>
        );
      })}
    </>
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
    <div className="vc-placeholder" style={{ background: `linear-gradient(160deg, ${hex || "#8a857a"}33, var(--panel))` }}>
      <span style={{ color: "var(--ink-soft)" }}>{initials}</span>
    </div>
  );
}

// ================= DETAIL VIEW =================
function DetailView({ record, entryNo, canEdit, onBack, onEdit, onDelete, onLyrics, onMoveToCollection }) {
  const [revealed, setRevealed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const links = streamLinks(record.artist, record.title);

  useEffect(() => {
    const t = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(t);
  }, [record.id]);

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
            <DiscStack record={record} spread={14} />
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
            {record.colorLabel && !finishHidesColor(record.finish) && (
              <>
                <span className="vc-dot-sep">·</span>
                <span className="vc-color-tag">
                  <span className="vc-chip-dot" style={{ background: record.colorHex }} />
                  {record.colorLabel}
                </span>
              </>
            )}
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
            {record.extraDiscs && record.extraDiscs.length > 0 && (
              <>
                <span className="vc-dot-sep">·</span>
                <span className="vc-color-tag">{record.extraDiscs.length + 1}× vinyl set</span>
              </>
            )}
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

          {record.info && (
            <div className="vc-story">
              <div className="vc-story-head">
                <span>More info</span>
              </div>
              <p className="vc-story-text">{record.info}</p>
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
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
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

  function addExtraDisc() {
    setForm((f) => ({
      ...f,
      extraDiscs: [
        ...(f.extraDiscs || []),
        { colorLabel: "Black", colorHex: "#161616", finish: "Standard (opaque)", discImageUrl: "", discImageX: 50, discImageY: 50, discImageZoom: 100 },
      ],
    }));
  }

  function removeExtraDisc(idx) {
    setForm((f) => ({ ...f, extraDiscs: (f.extraDiscs || []).filter((_, i) => i !== idx) }));
  }

  function updateExtraDisc(idx, key, value) {
    setForm((f) => ({
      ...f,
      extraDiscs: (f.extraDiscs || []).map((d, i) => (i === idx ? { ...d, [key]: value } : d)),
    }));
  }

  async function handleExtraDiscFile(idx, e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await resizeImageFile(file);
      updateExtraDisc(idx, "discImageUrl", dataUrl);
    } catch (err) {
      console.error("Couldn't process that image", err);
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
    <div className="vc-overlay">
      <div className="vc-modal" onKeyDown={handleKeyDown}>
        <div className="vc-modal-head">
          <h3 className="vc-title-brand">{editing ? "Edit record" : "Add a record"}</h3>
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
            <span>Label &amp; genre</span>
            <div className="vc-cover-row">
              <input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="Record label, e.g. Columbia Records" />
              <input value={form.genre} onChange={(e) => set("genre", e.target.value)} placeholder="Genre, e.g. Pop, Electropop" />
            </div>
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

          {!finishHidesColor(form.finish) && (
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
          )}

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

          <div className="vc-field vc-field-wide">
            <span className="vc-field-label-row">
              Additional vinyls in this set (optional — for multi-disc releases)
              <button type="button" className="vc-btn vc-btn-ghost vc-btn-sm" onClick={addExtraDisc}>
                <Plus size={13} /> Add another vinyl
              </button>
            </span>
            {(form.extraDiscs || []).length === 0 && (
              <p className="vc-hint">Leave empty for a standard single-disc release.</p>
            )}
            {(form.extraDiscs || []).map((disc, idx) => (
              <div key={idx} className="vc-extra-disc-card">
                <div className="vc-extra-disc-head">
                  <span>Vinyl {idx + 2}</span>
                  <button type="button" className="vc-icon-btn" onClick={() => removeExtraDisc(idx)}>
                    <X size={13} />
                  </button>
                </div>
                {!finishHidesColor(disc.finish) && (
                  <>
                    <div className="vc-color-row">
                      <input
                        type="color"
                        value={disc.colorHex}
                        onChange={(e) => updateExtraDisc(idx, "colorHex", e.target.value)}
                      />
                      <input
                        className="vc-color-label"
                        value={disc.colorLabel}
                        onChange={(e) => updateExtraDisc(idx, "colorLabel", e.target.value)}
                        placeholder="Color name"
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
                            updateExtraDisc(idx, "colorHex", p.hex);
                            updateExtraDisc(idx, "colorLabel", p.label);
                          }}
                        />
                      ))}
                    </div>
                  </>
                )}
                <div className="vc-finish-grid">
                  {FINISH_OPTIONS.map((f) => (
                    <button
                      type="button"
                      key={f}
                      className={`vc-finish-option ${disc.finish === f ? "is-active" : ""}`}
                      onClick={() => updateExtraDisc(idx, "finish", f)}
                      title={f}
                    >
                      <FinishIcon type={f} />
                      <span>{f}</span>
                    </button>
                  ))}
                </div>
                <div className="vc-cover-row">
                  <input
                    value={disc.discImageUrl && disc.discImageUrl.startsWith("data:") ? "" : disc.discImageUrl}
                    onChange={(e) => updateExtraDisc(idx, "discImageUrl", e.target.value)}
                    placeholder="Paste an image of this vinyl…"
                  />
                  <label className="vc-btn vc-btn-outline vc-btn-sm vc-upload-btn">
                    <Upload size={13} />
                    Upload
                    <input type="file" accept="image/*" hidden onChange={(e) => handleExtraDiscFile(idx, e)} />
                  </label>
                </div>
                {disc.discImageUrl && (
                  <div className="vc-disc-position">
                    <div className="vc-disc-position-preview">
                      <img
                        className="vc-disc-position-img"
                        src={disc.discImageUrl}
                        alt={`Vinyl ${idx + 2} preview`}
                        style={{
                          objectPosition: `${disc.discImageX ?? 50}% ${disc.discImageY ?? 50}%`,
                          transform: `scale(${(disc.discImageZoom ?? 100) / 100})`,
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
                          value={disc.discImageZoom ?? 100}
                          onChange={(e) => updateExtraDisc(idx, "discImageZoom", Number(e.target.value))}
                        />
                      </label>
                      <label className="vc-slider-row">
                        <span>Shift left / right</span>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={disc.discImageX ?? 50}
                          onChange={(e) => updateExtraDisc(idx, "discImageX", Number(e.target.value))}
                        />
                      </label>
                      <label className="vc-slider-row">
                        <span>Shift up / down</span>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={disc.discImageY ?? 50}
                          onChange={(e) => updateExtraDisc(idx, "discImageY", Number(e.target.value))}
                        />
                      </label>
                      <button
                        type="button"
                        className="vc-btn vc-btn-ghost vc-btn-sm"
                        onClick={() => updateExtraDisc(idx, "discImageUrl", "")}
                      >
                        Remove image
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <label className="vc-field vc-field-wide">
            <span>Tracklist (for the lyrics page)</span>
            <textarea
              rows={5}
              value={form.tracklist}
              onChange={(e) => set("tracklist", e.target.value)}
              placeholder={"1. Track one\n2. Track two\n3. Track three"}
            />
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

html, body, #root { margin: 0; padding: 0; min-height: 100%; }

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
  --glass: rgba(245, 243, 238, 0.68);
  --glass-border: rgba(221, 215, 200, 0.7);
  --glass-highlight: rgba(255, 255, 255, 0.65);
  --badge-bg: rgba(245, 243, 238, 0.9);
  font-family: 'Inter', sans-serif;
  background: var(--paper);
  color: var(--ink);
  min-height: 100vh;
  padding: 30px 34px 64px;
  box-sizing: border-box;
  transition: background 0.2s ease, color 0.2s ease;
}
.vc-root[data-theme="dark"] {
  --ink: #f0ede4;
  --ink-soft: #a29c8c;
  --paper: #16151a;
  --panel: #201f26;
  --panel-2: #26252d;
  --line: #38363f;
  --accent: #7c9cd6;
  --accent-tint: #7c9cd626;
  --rust: #d98a78;
  --glass: rgba(22, 21, 26, 0.55);
  --glass-border: rgba(56, 54, 63, 0.7);
  --glass-highlight: rgba(255, 255, 255, 0.07);
  --badge-bg: rgba(32, 31, 38, 0.88);
}
.vc-root * { box-sizing: border-box; }
.vc-mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.82em; color: var(--ink-soft); }

.vc-nav-glass {
  position: sticky;
  top: 0;
  z-index: 60;
  margin: -30px -34px 30px;
  padding: 18px 34px 0;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border-bottom: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 var(--glass-highlight), 0 8px 30px -18px #00000030;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.vc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 18px;
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
.vc-title-brand {
  font-family: 'Inter', sans-serif !important;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  font-size: 1.15rem !important;
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
.vc-theme-toggle {
  width: 44px; height: 24px; border-radius: 999px; border: 1px solid var(--glass-border);
  background: var(--glass); backdrop-filter: blur(10px);
  padding: 2px; cursor: pointer; display: flex; align-items: center;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.vc-theme-thumb {
  width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--paper);
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.2s cubic-bezier(.4,0,.2,1), background 0.2s ease;
}
.vc-theme-thumb.is-dark { transform: translateX(20px); }
.vc-tally {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.72rem;
  color: var(--ink-soft);
  letter-spacing: 0.03em;
}

.vc-tabs { display: flex; gap: 6px; }
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
  position: relative; border-radius: 6px; overflow: hidden; padding: 0; width: 100%;
  background: var(--panel); border: 1px solid var(--line); cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.vc-history-tile::before { content: ""; display: block; padding-top: 100%; }
.vc-history-tile:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 14px 24px -16px #00000030; }
.vc-history-tile img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.vc-history-badge {
  position: absolute; bottom: 8px; left: 8px;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; letter-spacing: 0.04em; text-transform: uppercase;
  background: var(--badge-bg); color: var(--ink-soft); padding: 3px 7px; border-radius: 3px; backdrop-filter: blur(2px);
}

/* --- Tilted cover effect (Collection grid) --- */
.vc-history-tile-tilt,
.vc-history-tile-tilt:hover {
  overflow: visible; background: transparent; border-color: transparent;
  box-shadow: none; transform: none;
}
.vc-history-tile-tilt:hover { z-index: 5; }
.vc-history-tile-tilt:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 8px; }
.vc-tilt-figure { position: absolute; inset: 0; perspective: 800px; }
.vc-tilt-inner { position: relative; width: 100%; height: 100%; transform-style: preserve-3d; }
.vc-tilt-inner img, .vc-tilt-inner .vc-placeholder {
  border-radius: 6px;
  border: 1px solid var(--line);
  box-sizing: border-box;
  box-shadow: 0 16px 32px -20px #00000059;
}
.vc-tilt-overlay {
  position: absolute; inset: 0; z-index: 2;
  pointer-events: none;
  transform: translateZ(30px);
}
.vc-tilt-chip {
  position: absolute; top: 10px; left: 10px; max-width: calc(100% - 20px);
  box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem; font-weight: 500;
  letter-spacing: 0.05em; text-transform: uppercase;
  background: var(--badge-bg); color: var(--ink); border: 1px solid var(--line);
  padding: 5px 11px; border-radius: 6px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; transform: translateY(-4px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.vc-history-tile-tilt:hover .vc-tilt-chip,
.vc-history-tile-tilt:focus-visible .vc-tilt-chip { opacity: 1; transform: translateY(0); }
@media (hover: none) { .vc-tilt-chip { display: none; } }
.vc-tilt-caption {
  pointer-events: none; position: absolute; left: 0; top: 0; z-index: 6;
  background: var(--badge-bg); color: var(--ink); border: 1px solid var(--line);
  border-radius: 4px; padding: 4px 9px;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; letter-spacing: 0.05em; text-transform: uppercase;
  white-space: nowrap; opacity: 0; backdrop-filter: blur(2px);
}
@media (max-width: 700px) { .vc-tilt-caption { display: none; } }

/* --- About: scroll essay --- */
.vc-essay { max-width: 680px; margin: 0 auto; }

/* Scroll reveal: hidden until IntersectionObserver adds .is-visible */
.vc-essay-block {
  opacity: 0; transform: translateY(34px);
  transition: opacity 0.9s cubic-bezier(0.22, 1, 0.36, 1), transform 0.9s cubic-bezier(0.22, 1, 0.36, 1);
}
.vc-essay-block.is-visible { opacity: 1; transform: none; }

.vc-essay-hero {
  min-height: 78vh; position: relative;
  display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
}
.vc-essay-hero h2 {
  font-family: 'Inter', sans-serif; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase;
  font-size: clamp(2.4rem, 6.4vw, 4.2rem); line-height: 1.08;
  margin: 0 0 20px; color: var(--ink);
}
.vc-essay-sub { font-size: 1.02rem; color: var(--ink-soft); margin: 0; }

.vc-essay-scrollhint {
  position: absolute; bottom: 26px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--ink-soft); opacity: 0.55;
  transition: opacity 0.5s ease;
  pointer-events: none;
}
.vc-essay-scrollhint-arrow {
  display: inline-block; letter-spacing: 0;
  animation: vc-scrollhint-bob 1.6s ease-in-out infinite;
}
@keyframes vc-scrollhint-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(6px); }
}
.vc-essay-scrollhint.is-hidden { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .vc-essay-scrollhint-arrow { animation: none; } }

.vc-essay-eyebrow {
  font-family: 'IBM Plex Mono', monospace; font-size: 0.7rem;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--accent); margin: 0 0 18px;
}

.vc-essay-block:not(.vc-essay-hero):not(.vc-essay-closing) { padding: 8vh 0; }
.vc-essay-block h3 {
  font-family: 'Inter', sans-serif; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  font-size: clamp(1.35rem, 2.9vw, 1.95rem); line-height: 1.28;
  margin: 0 0 24px; color: var(--ink);
}
.vc-essay-block p:not(.vc-essay-eyebrow):not(.vc-essay-accent):not(.vc-essay-record):not(.vc-essay-sig):not(.vc-essay-sig-final) {
  font-size: 1rem; line-height: 1.78; color: var(--ink-soft); margin: 0 0 16px; max-width: 60ch;
}
.vc-essay-accent {
  font-family: 'Inter', sans-serif; font-style: italic; font-weight: 500;
  font-size: clamp(1.15rem, 2.4vw, 1.4rem); line-height: 1.5;
  color: var(--ink); margin: 24px 0 16px;
}

/* --- Circular gallery: full-bleed WebGL carousel of covers, A→Z --- */
body { overflow-x: clip; } /* clip (not hidden) keeps sticky nav working */
.vc-essay-gallery-block { padding: 5vh 0 3vh; }
.vc-essay-gallery-label { text-align: center; margin-bottom: 6px; }
.vc-essay-gallery {
  width: 100vw; margin-left: calc(50% - 50vw);
  height: 480px; position: relative;
}
.vc-circular-gallery {
  width: 100%; height: 100%;
  overflow: hidden; cursor: grab; touch-action: pan-y;
}
.vc-circular-gallery:active { cursor: grabbing; }
.vc-circular-gallery:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
@media (max-width: 900px) {
  .vc-essay-gallery { height: 340px; }
}
.vc-essay-record {
  font-family: 'Inter', sans-serif; font-style: italic; font-weight: 500;
  font-size: clamp(1.25rem, 2.7vw, 1.6rem); line-height: 1.4;
  color: var(--ink); margin: 4px 0 18px;
  padding-left: 18px; border-left: 2px solid var(--accent);
}

/* Closing: full-bleed finale, photo pinned to the bottom-right of the page */
.vc-essay-closing {
  position: relative; min-height: 88vh;
  width: 100vw; margin-left: calc(50% - 50vw);
  /* pull over vc-root's bottom padding so the photo touches the page edge */
  margin-bottom: -64px;
  display: flex; flex-direction: column; justify-content: center;
  padding: 8vh 34px 0 max(34px, calc(50vw - 340px));
  box-sizing: border-box; overflow: hidden;
}
.vc-essay-closing-text { position: relative; z-index: 2; }
.vc-essay-closing h3 {
  font-family: 'IBM Plex Mono', monospace; font-weight: 500;
  font-size: 0.78rem; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--accent); margin: 0 0 22px;
}
.vc-essay-sig {
  font-family: 'Inter', sans-serif; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  font-size: clamp(1.6rem, 3.6vw, 2.4rem); line-height: 1.3;
  color: var(--ink); margin: 0 0 26px;
}
.vc-essay-sig-final {
  font-family: 'Inter', sans-serif; font-style: italic; font-weight: 500;
  font-size: clamp(1.15rem, 2.4vw, 1.4rem);
  color: var(--ink-soft); margin: 0;
}
.vc-about-photo {
  position: absolute; right: clamp(8px, 4vw, 80px); bottom: 0; z-index: 1;
  height: min(78vh, 640px); width: auto;
  object-fit: contain; object-position: bottom right;
  pointer-events: none; user-select: none;
  opacity: 0; transform: translateY(64px);
  transition: opacity 1.15s cubic-bezier(0.22, 1, 0.36, 1) 0.25s, transform 1.15s cubic-bezier(0.22, 1, 0.36, 1) 0.25s;
}
.vc-essay-closing.is-visible .vc-about-photo { opacity: 1; transform: none; }

@media (max-width: 900px) {
  .vc-essay-hero { min-height: 62vh; }
  .vc-essay-block:not(.vc-essay-hero):not(.vc-essay-closing) { padding: 7vh 0; }
  .vc-essay-closing { min-height: 0; padding: 6vh 20px 0; margin-bottom: -96px; }
  .vc-about-photo {
    position: static; align-self: flex-end;
    height: auto; max-height: 380px; max-width: 92%; margin-top: 30px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .vc-essay-block, .vc-about-photo { opacity: 1 !important; transform: none !important; transition: none !important; }
}

.vc-fab {
  position: fixed; bottom: 30px; right: 30px; z-index: 40;
  width: 54px; height: 54px; border-radius: 50%;
  background: var(--glass); color: var(--ink); border: 1px solid var(--glass-border);
  backdrop-filter: blur(18px) saturate(180%); -webkit-backdrop-filter: blur(18px) saturate(180%);
  display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0 1px 0 var(--glass-highlight), 0 12px 26px -8px #00000030; cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.vc-fab:hover { transform: translateY(-2px); border-color: var(--accent); color: var(--accent); }
.vc-fab:active { transform: translateY(0) scale(0.94); }
.vc-fab-secondary { bottom: 96px; width: 46px; height: 46px; }
.vc-share-modal {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius);
  width: 100%; max-width: 520px; max-height: 88vh; overflow-y: auto; padding: 24px 26px;
  box-shadow: 0 30px 60px -20px #00000040;
}
.vc-share-preview { width: 100%; display: block; border-radius: 8px; margin: 14px 0; border: 1px solid var(--line); }
.vc-share-sort { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.vc-share-sort > span { font-size: 0.76rem; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }

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
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  text-decoration: none;
}
.vc-btn:hover { border-color: var(--accent); color: var(--accent); }
.vc-btn:active { transform: scale(0.97); }
.vc-btn:focus-visible, .vc-icon-btn:focus-visible, .vc-fab:focus-visible, .vc-theme-toggle:focus-visible, .vc-chip:focus-visible, .vc-tab:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
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

.vc-warning { background: color-mix(in srgb, var(--rust) 14%, var(--paper)); border: 1px solid var(--rust); color: var(--rust); padding: 10px 14px; border-radius: 6px; font-size: 0.82rem; margin-bottom: 16px; }

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
  position: relative;
  transition: transform 0.15s ease;
}
.vc-sleeve.is-draggable { cursor: grab; }
.vc-sleeve.is-draggable:active { cursor: grabbing; }
.vc-sleeve.is-drag-over .vc-sleeve-cover { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-tint); }
.vc-reorder-controls {
  position: absolute; top: 6px; right: 6px; z-index: 4;
  display: flex; align-items: center; gap: 2px;
  background: var(--badge-bg); border-radius: 999px; padding: 2px;
  backdrop-filter: blur(2px);
}
.vc-drag-handle-inline { color: var(--ink-soft); display: flex; align-items: center; }
.vc-reorder-btn {
  width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer;
  background: transparent; color: var(--ink); display: flex; align-items: center; justify-content: center;
}
.vc-reorder-btn:hover { background: var(--accent-tint); color: var(--accent); }
.vc-reorder-btn:disabled { opacity: 0.3; cursor: default; }
.vc-drag-hint {
  display: flex; align-items: center; gap: 8px;
  font-size: 0.78rem; color: var(--ink-soft); margin-bottom: 16px;
}
.vc-sleeve-stage { position: relative; width: 100%; }
.vc-sleeve-stage::before { content: ""; display: block; padding-top: 100%; }
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
  background: var(--badge-bg); color: var(--ink-soft); padding: 3px 6px; border-radius: 3px;
  backdrop-filter: blur(2px);
}
.vc-sleeve-highlight {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; letter-spacing: 0.05em; text-transform: uppercase;
  background: var(--accent); color: #fbfaf7; padding: 3px 7px; border-radius: 3px;
  box-shadow: 0 2px 6px -2px #00000050;
}
.vc-stage-highlight { top: 12px; right: 12px; font-size: 0.66rem; padding: 4px 9px; }
.vc-disc-layer {
  position: absolute; inset: 0;
  transform: translateX(0);
  transition: transform 0.6s cubic-bezier(.16,1,.3,1);
}
/* On reveal each layer slides to its precomputed offset (set inline by DiscStack);
   the back disc travels the container's full distance, discs in front trail left. */
.vc-sleeve:hover .vc-disc-layer,
.vc-stage.is-revealed .vc-disc-layer {
  transform: translateX(var(--disc-offset, 0%));
}
.vc-disc-face {
  position: absolute; inset: 0; border-radius: 50%; overflow: hidden;
}
.vc-disc-face-img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
.vc-disc-face-plain { display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 1px var(--line) inset; }
.vc-disc-label {
  position: absolute; inset: 38% 38% 38% 38%; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #00000022 inset;
}
.vc-disc-hole { width: 22%; height: 22%; border-radius: 50%; background: var(--paper); box-shadow: 0 0 0 1px #00000022 inset; }

.vc-placeholder {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
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

.vc-stage { position: relative; width: 100%; }
.vc-stage::before { content: ""; display: block; padding-top: 100%; }
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
  transform: translateX(24%);
  opacity: 1;
}
.vc-stage-disc .vc-disc-face { transition: transform 1.1s cubic-bezier(.16,1,.3,1); }
.vc-stage.is-revealed .vc-disc-layer > .vc-disc-face {
  transform: rotate(360deg);
  animation: vc-record-rotate 26s linear infinite;
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
  position: fixed; inset: 0; background: #14131688; backdrop-filter: blur(8px) saturate(140%);
  -webkit-backdrop-filter: blur(8px) saturate(140%);
  display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 70;
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
.vc-extra-disc-card {
  border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-top: 10px;
  background: var(--paper); display: flex; flex-direction: column; gap: 10px;
}
.vc-extra-disc-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 0.78rem; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em;
}

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
.vc-remember { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: var(--ink-soft); cursor: pointer; user-select: none; }
.vc-remember input { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
.vc-form-error { margin: 0 auto 0 0; }

@keyframes vc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes vc-pop { from { opacity: 0; transform: scale(0.96) translateY(6px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes vc-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes vc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes vc-record-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }


/* ---------- toast ---------- */
.vc-toast {
  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
  z-index: 80; display: flex; align-items: center; gap: 9px;
  background: var(--glass); color: var(--ink);
  border: 1px solid var(--glass-border); border-radius: 999px;
  padding: 11px 20px; font-size: 0.88rem; font-weight: 500;
  backdrop-filter: blur(18px) saturate(180%); -webkit-backdrop-filter: blur(18px) saturate(180%);
  box-shadow: inset 0 1px 0 var(--glass-highlight), 0 14px 30px -12px #00000045;
  animation: vc-toast-in 0.3s cubic-bezier(.2,.9,.3,1.2);
}
.vc-toast-check { color: var(--accent); }
.vc-toast-tick { stroke-dasharray: 16; stroke-dashoffset: 16; animation: vc-tick 0.4s 0.15s ease forwards; }
@keyframes vc-tick { to { stroke-dashoffset: 0; } }
@keyframes vc-toast-in { from { opacity: 0; transform: translateX(-50%) translateY(14px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

/* ---------- NEW badges ---------- */
/* Own chip at the bottom-left of the cover (mirrors .vc-history-badge) so it
   can never collide with the No. pill (top-left) or LIMITED/SIGNED (top-right). */
.vc-sleeve-new {
  position: absolute; bottom: 8px; left: 8px; z-index: 3;
  font-family: 'IBM Plex Mono', monospace; font-size: 0.58rem; letter-spacing: 0.06em; text-transform: uppercase;
  background: var(--accent); color: #fbfaf7; padding: 3px 7px; border-radius: 3px;
  box-shadow: 0 2px 6px -2px #00000050;
}
.vc-history-badge-new { left: auto; right: 8px; background: var(--accent); color: #fbfaf7; }

/* ---------- insights ---------- */
.vc-insights-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 26px; }
.vc-insight-totals { display: flex; gap: 26px; flex-wrap: wrap; }
.vc-insight-total strong { display: block; font-family: 'Inter', sans-serif; font-size: 1.8rem; font-weight: 600; letter-spacing: 0.02em; line-height: 1.1; }
.vc-insight-total span { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.06em; }
.vc-insights-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
.vc-insight-block { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
.vc-insight-block h3 { margin: 0 0 14px; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
.vc-insight-row { display: grid; grid-template-columns: minmax(90px, 40%) 1fr auto; align-items: center; gap: 10px; margin-bottom: 8px; }
.vc-insight-label { font-size: 0.8rem; display: flex; align-items: center; gap: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-insight-bar-track { height: 7px; background: var(--paper); border-radius: 99px; overflow: hidden; }
.vc-insight-bar { display: block; height: 100%; background: var(--accent); border-radius: 99px; opacity: 0.75; }
.vc-insight-n { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--ink-soft); min-width: 2ch; text-align: right; }

/* ---------- mobile ---------- */
@media (max-width: 760px) {
  .vc-root { padding: 18px 16px 96px; }
  .vc-nav-glass { margin: -18px -16px 22px; padding: 12px 16px 0; }
  .vc-header { flex-wrap: wrap; gap: 10px 14px; padding-bottom: 12px; }
  .vc-brand h1 { font-size: 1.02rem; }
  .vc-brand p { font-size: 0.62rem; }
  .vc-header-actions { gap: 10px; margin-left: auto; }
  .vc-header-actions .vc-btn-primary { padding: 8px 12px; font-size: 0.76rem; }
  .vc-tabs { overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .vc-tabs::-webkit-scrollbar { display: none; }
  .vc-tab { margin-right: 14px; white-space: nowrap; }

  .vc-toolbar { flex-wrap: wrap; gap: 10px; }
  .vc-toolbar > * { flex: 1 1 auto; }

  .vc-chips { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
  .vc-chips::-webkit-scrollbar { display: none; }
  .vc-chip { white-space: nowrap; flex: 0 0 auto; }

  .vc-grid { grid-template-columns: repeat(2, 1fr); gap: 22px 26px; }
  .vc-history-grid { gap: 12px; }

  .vc-detail-grid { gap: 24px; }
  .vc-stage { width: min(320px, 100%); margin: 0 auto; }
  .vc-actions { gap: 8px; }
  .vc-stream-btn { padding: 8px 12px 8px 10px; font-size: 0.78rem; }

  .vc-modal, .vc-share-modal { padding: 18px 16px; max-height: 92vh; border-radius: 12px; }
  .vc-form-grid { grid-template-columns: 1fr; }
  .vc-field-row, .vc-cover-row { flex-direction: column; align-items: stretch; }
  .vc-cover-row .vc-upload-btn { align-self: flex-start; }
  .vc-disc-position { flex-direction: column; }

  .vc-fab { bottom: 20px; right: 16px; }
  .vc-fab-secondary { bottom: 84px; }
  .vc-insights-grid { grid-template-columns: 1fr; }
  .vc-toast { bottom: 88px; width: max-content; max-width: calc(100vw - 32px); }
}

@media (prefers-reduced-motion: reduce) {
  .vc-sleeve, .vc-sleeve-disc, .vc-stage-disc, .vc-disc-layer, .vc-disc-face, .vc-spin-slow { animation: none !important; transition: none !important; }
}
`;
