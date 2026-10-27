import { Box, ButtonBase } from "@mui/material";
import username from "username";
import { join } from "path";
import { KeyboardEvent, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useObservable } from "rxjs-hooks";
import { SkinId, stringToSkinId } from "../../model/SkinId";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { readOsuSkinInUse } from "../../services/setup/osu-skin-in-use";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { buildSkinOptions, filterSkinOptions, SkinOption } from "./skin-options";

/**
 * The Skin tab (docs/design/rewind-3a/addon-1/17c, mock lines 280-299): one searchable list of the skins, the one
 * osu! uses first. The list opens below its button in the normal flow, so it pushes the footer down instead of
 * covering it.
 */

/** The list surface of the mock (#22232a), the row hover and the active row: literals that have no token. */
const LIST_SURFACE = "#22232a";
const ROW_HOVER = "rgba(255,255,255,0.06)";
const ROW_ACTIVE = "rgba(255,255,255,0.08)";
const LIST_MAX_HEIGHT = 278;
const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
/** The height of the bottom fade: a row moved to by the keyboard must stop above it. */
const FADE_HEIGHT = 40;

/** Folder skin names are compared without regard to case (Windows paths are case-insensitive, as is the cfg match). */
const sameSkin = (a: SkinId, b: SkinId) =>
  a.source === b.source && (a.source === "osu" ? a.name.toLowerCase() === b.name.toLowerCase() : a.name === b.name);

function parseSkinId(stored: string): SkinId | undefined {
  try {
    return stringToSkinId(stored);
  } catch {
    return undefined;
  }
}

/** A skin name has no spaces to break at, so the line wraps anywhere instead of overflowing a narrow inspector. */
const alertSx = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: "16px",
  overflowWrap: "anywhere",
  color: REWIND_COLORS.judgementMiss,
} as const;

function safeOsuFolder(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

async function userNameOrEmpty(): Promise<string> {
  try {
    return (await username()) ?? "";
  } catch {
    return "";
  }
}

function UsedInOsu() {
  return (
    <Box
      component="span"
      sx={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: "5px",
        fontSize: 11.5,
        fontWeight: 500,
        color: REWIND_COLORS.accentSoft,
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: REWIND_COLORS.accent,
          boxShadow: `0 0 6px ${REWIND_COLORS.accentGlow}`,
        }}
      />
      Used in osu!
    </Box>
  );
}

const SkinRow = memo(function SkinRow({
  id,
  option,
  selected,
  active,
  onChoose,
}: {
  id: string;
  option: SkinOption;
  selected: boolean;
  active: boolean;
  onChoose(option: SkinOption): void;
}) {
  return (
    <Box
      id={id}
      role="option"
      aria-selected={selected}
      onMouseDown={preventPointerFocus}
      onClick={() => onChoose(option)}
      sx={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        minHeight: 34,
        px: "10px",
        borderRadius: "5px",
        cursor: "pointer",
        textAlign: "left",
        scrollMarginBottom: `${FADE_HEIGHT}px`,
        backgroundColor: active ? ROW_ACTIVE : "transparent",
        "&:hover": { backgroundColor: active ? ROW_ACTIVE : ROW_HOVER },
      }}
    >
      <Box component="span" aria-hidden="true" sx={{ width: 12, flex: "none", display: "grid", placeItems: "center" }}>
        {selected && (
          <svg width="12" height="12" viewBox="0 0 12 12" focusable="false" style={{ display: "block" }}>
            <polyline
              points="2,6.5 5,9 10,3"
              style={{ fill: "none", stroke: REWIND_COLORS.textPrimary, strokeWidth: 1.7 }}
            />
          </svg>
        )}
      </Box>
      <Box
        component="span"
        title={option.label}
        sx={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontSize: 13,
          fontWeight: selected ? 600 : 400,
          color: selected ? REWIND_COLORS.white : option.note ? REWIND_COLORS.textSecondary : REWIND_COLORS.textBright,
        }}
      >
        {option.label}
      </Box>
      {option.usedInOsu && <UsedInOsu />}
      {option.note && (
        <Box component="span" sx={{ flex: "none", fontFamily: REWIND_FONTS.mono, fontSize: 11, color: REWIND_COLORS.textDim }}>
          {option.note}
        </Box>
      )}
    </Box>
  );
});

export function SkinTab() {
  const { skinManager, skinSettingsStore } = useCommonManagers();
  const { osuFolderService } = useAnalysisApp();
  const folderSkins = useObservable(() => skinManager.skinList$, skinManager.skinList$.getValue());
  const { preferredSkinId } = useObservable(() => skinSettingsStore.settings$, skinSettingsStore.settings);

  const [skinInUse, setSkinInUse] = useState<string | undefined>(undefined);
  const [osuFolder, setOsuFolder] = useState("");
  const [scanning, setScanning] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [atEnd, setAtEnd] = useState(true);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const labelId = `${baseId}-label`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scanRun = useRef(0);
  const choiceRun = useRef(0);
  const mounted = useRef(false);

  const options = useMemo(() => buildSkinOptions(folderSkins, skinInUse), [folderSkins, skinInUse]);
  const visible = useMemo(() => filterSkinOptions(options, query), [options, query]);
  const currentId = useMemo(() => parseSkinId(preferredSkinId), [preferredSkinId]);
  const current = currentId ? options.find((option) => sameSkin(option.id, currentId)) : undefined;
  const currentLabel = current?.label ?? currentId?.name ?? preferredSkinId;
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0));

  const scan = useCallback(async () => {
    const run = ++scanRun.current;
    setScanning(true);
    const folder = safeOsuFolder(() => osuFolderService.getOsuFolder());
    setOsuFolder(folder);
    const listRead = skinManager.loadSkinList().then(
      () => true,
      () => false,
    );
    const cfgRead = userNameOrEmpty()
      .then((userName) => readOsuSkinInUse(folder, userName))
      .catch(() => undefined);
    const [listed, inUse] = await Promise.all([listRead, cfgRead]);
    // A scan that outlived the tab, or that a newer scan replaced, must not write.
    if (run !== scanRun.current) return;
    setListFailed(!listed);
    setSkinInUse(inUse);
    setScanning(false);
  }, [osuFolderService, skinManager]);

  const dropPendingScans = useCallback(() => {
    scanRun.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void scan();
    return () => {
      mounted.current = false;
      dropPendingScans();
    };
  }, [scan, dropPendingScans]);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (list) setAtEnd(list.scrollHeight - list.scrollTop - list.clientHeight <= 1);
  }, []);
  useLayoutEffect(measure, [measure, open, visible.length]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // jsdom has no scrollIntoView.
    document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, baseId]);

  const openList = () => {
    const selectedIndex = currentId ? options.findIndex((option) => sameSkin(option.id, currentId)) : -1;
    setQuery("");
    setActive(Math.max(selectedIndex, 0));
    setOpen(true);
  };
  const closeList = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (option: SkinOption, viaKeyboard = false) => {
      const choice = ++choiceRun.current;
      setLoadFailure(null);
      closeList(viaKeyboard);
      void (async () => {
        try {
          await skinManager.loadSkin(option.id);
        } catch {
          if (mounted.current && choice === choiceRun.current) setLoadFailure(option.label);
        }
      })();
    },
    [skinManager, closeList],
  );
  // Rows are memoised on a handler that never changes, so moving the active row re-renders only two of them.
  const chooseRow = useCallback((option: SkinOption) => choose(option), [choose]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) return;
    // An IME confirms or cancels a composition with Enter or Escape; neither may choose a skin or close the list.
    if (event.nativeEvent.isComposing) {
      // The IME owns Escape too: keep it from closing Settings, but let it cancel the composition.
      if (event.key === "Escape") event.stopPropagation();
      return;
    }
    const inSearch = event.target === searchRef.current;
    switch (event.key) {
      case "Escape":
        // Settings closes on an Escape that reaches `window` un-prevented; with the list open, focus anywhere in
        // this tab closes only the list and returns to its button.
        event.preventDefault();
        event.stopPropagation();
        closeList(true);
        break;
      case "ArrowDown":
        if (!inSearch) break;
        event.preventDefault();
        if (visible.length > 0) setActive(Math.min(activeIndex + 1, visible.length - 1));
        break;
      case "ArrowUp":
        if (!inSearch) break;
        event.preventDefault();
        if (visible.length > 0) setActive(Math.max(activeIndex - 1, 0));
        break;
      case "Enter":
        if (!inSearch) break;
        event.preventDefault();
        if (visible[activeIndex]) choose(visible[activeIndex], true);
        break;
    }
  };

  const skinsFolder = osuFolder.trim() === "" ? "" : join(osuFolder, "Skins");

  return (
    <Box
      role="group"
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
      sx={{ flex: "none", display: "flex", flexDirection: "column", gap: "12px", p: "16px 20px" }}
    >
      <Box
        component="span"
        id={labelId}
        sx={{
          fontFamily: REWIND_FONTS.mono,
          fontWeight: 500,
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: REWIND_COLORS.textTertiary,
        }}
      >
        Skin
      </Box>

      <Box sx={{ position: "relative", display: "flex", flexDirection: "column" }}>
        <ButtonBase
          ref={triggerRef}
          aria-expanded={open}
          aria-controls={open && visible.length > 0 ? listboxId : undefined}
          onClick={() => (open ? closeList(false) : openList())}
          onMouseDown={preventPointerFocus}
          sx={{
            height: 40,
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            px: "12px",
            borderRadius: "8px",
            textAlign: "left",
            fontFamily: REWIND_FONTS.ui,
            color: REWIND_COLORS.textPrimary,
            backgroundColor: REWIND_COLORS.inset,
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28)",
            "&:hover": { boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.4)" },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          <Box
            component="span"
            title={currentLabel}
            sx={{
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            {currentLabel}
          </Box>
          {current?.usedInOsu && <UsedInOsu />}
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true" focusable="false" style={{ marginLeft: 4, flex: "none" }}>
            <polyline
              points="1,1 5,5 9,1"
              style={{ fill: "none", stroke: REWIND_COLORS.textBright, strokeWidth: 1.5 }}
            />
          </svg>
        </ButtonBase>

        {open && (
          <Box
            sx={{
              mt: "6px",
              display: "flex",
              flexDirection: "column",
              backgroundColor: LIST_SURFACE,
              borderRadius: "9px",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 16px 40px rgba(0,0,0,0.55)",
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                height: 40,
                px: "12px",
                boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.08)",
                "&:focus-within": { boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.28)" },
              }}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false" style={{ flex: "none" }}>
                <circle cx="5.5" cy="5.5" r="4" style={{ fill: "none", stroke: REWIND_COLORS.textSecondary, strokeWidth: 1.5 }} />
                <path d="M8.5 8.5 L12 12" style={{ stroke: REWIND_COLORS.textSecondary, strokeWidth: 1.5 }} />
              </svg>
              <Box
                component="input"
                ref={searchRef}
                type="text"
                role="combobox"
                aria-label="Search skins"
                aria-expanded
                aria-autocomplete="list"
                aria-controls={visible.length > 0 ? listboxId : undefined}
                aria-activedescendant={visible.length > 0 ? optionId(activeIndex) : undefined}
                autoComplete="off"
                spellCheck={false}
                placeholder={`Search ${options.length} skins`}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  if (listRef.current) listRef.current.scrollTop = 0;
                }}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  height: 28,
                  p: 0,
                  border: 0,
                  background: "transparent",
                  fontFamily: REWIND_FONTS.ui,
                  fontSize: 13,
                  color: REWIND_COLORS.textPrimary,
                  "&::placeholder": { color: REWIND_COLORS.textDim, opacity: 1 },
                  // No ring on the field itself: the search row's hairline marks focus instead.
                  outline: "none",
                  "&:focus-visible": { outline: "none" },
                }}
              />
            </Box>
            {visible.length > 0 ? (
              <Box sx={{ position: "relative" }}>
                <Box
                  ref={listRef}
                  id={listboxId}
                  role="listbox"
                  aria-label="Skins"
                  onScroll={measure}
                  sx={{
                    boxSizing: "border-box",
                    p: "4px",
                    display: "flex",
                    flexDirection: "column",
                    maxHeight: LIST_MAX_HEIGHT,
                    overflowY: "auto",
                    overscrollBehavior: "contain",
                    ...thinScrollbar,
                  }}
                >
                  {visible.map((option, index) => (
                    <SkinRow
                      key={`${option.id.source}:${option.id.name}`}
                      id={optionId(index)}
                      option={option}
                      selected={currentId !== undefined && sameSkin(option.id, currentId)}
                      active={index === activeIndex}
                      onChoose={chooseRow}
                    />
                  ))}
                </Box>
                <Box
                  aria-hidden="true"
                  data-scroll-fade=""
                  sx={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: FADE_HEIGHT,
                    background: `linear-gradient(rgba(34,35,42,0), ${LIST_SURFACE})`,
                    pointerEvents: "none",
                    borderRadius: "0 0 9px 9px",
                    opacity: atEnd ? 0 : 1,
                    transition: "opacity 120ms ease-out",
                    [REDUCED_MOTION]: { transition: "none" },
                  }}
                />
              </Box>
            ) : (
              <Box role="status" sx={{ px: "12px", py: "10px", fontSize: 13, color: REWIND_COLORS.textDim }}>
                No skins match.
              </Box>
            )}
          </Box>
        )}
      </Box>

      {loadFailure !== null && (
        <Box role="alert" sx={alertSx}>
          {`Couldn't load ${loadFailure}. The previous skin is still in use.`}
        </Box>
      )}
      {listFailed && (
        <Box role="alert" sx={alertSx}>
          Couldn't read the Skins folder.
        </Box>
      )}

      <Box sx={{ display: "flex", alignItems: "center", gap: "8px", fontSize: 12, color: REWIND_COLORS.textTertiary }}>
        <Box
          component="span"
          sx={{
            flex: 1,
            minWidth: 0,
            fontFamily: REWIND_FONTS.mono,
            fontSize: 11.5,
            overflowWrap: "anywhere",
          }}
        >
          {skinsFolder}
        </Box>
        <ButtonBase
          disabled={scanning}
          onClick={() => void scan()}
          onMouseDown={preventPointerFocus}
          sx={{
            flex: "none",
            height: 26,
            px: "8px",
            borderRadius: "5px",
            fontFamily: REWIND_FONTS.ui,
            fontWeight: 500,
            fontSize: 12,
            color: REWIND_COLORS.textMuted,
            "&:hover": { backgroundColor: "rgba(255,255,255,0.07)", color: REWIND_COLORS.white },
            "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          Rescan
        </ButtonBase>
      </Box>
    </Box>
  );
}
