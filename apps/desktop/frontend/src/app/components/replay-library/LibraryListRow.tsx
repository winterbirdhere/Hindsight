import { useId } from "react";
import { REWIND_COLORS as c } from "../../styles/tokens";
import {
  LibraryArtwork, LibraryCombo, LibraryReplayMods, libraryConfirmedFC, libraryFullComboSource, libraryGradeColor,
  libraryLength, libraryNumber, libraryRelativeDate, type ReplayItemProps,
} from "./LibraryReplay";
import { LIBRARY_LIST_COLUMNS, type LibraryListColumn } from "./library-list-layout";
import { LibraryButton, LibraryIcon } from "./library-view-controls";
import { ANALYSIS_LABELS } from "./library-view-types";

interface LibraryListRowProps extends ReplayItemProps {
  listColumns?: readonly LibraryListColumn[];
}

export function LibraryReplayRow({
  item, resource, selected, onSelect, onOpen, onSave, index, listColumns = LIBRARY_LIST_COLUMNS,
}: LibraryListRowProps) {
  const positionId = useId();
  const title = item.title ?? "Unknown beatmap";
  const subtitle = `${item.artist ?? "Unknown artist"} · [${item.difficulty ?? "Unknown difficulty"}]${
    item.completion === "failed" ? " · Failed · no pp awarded" : ""
  }`;
  const confirmedFC = libraryConfirmedFC(item);
  const date = item.values.date === null ? null : new Date(item.values.date);
  const played = date && Number.isFinite(date.getTime()) ? date : null;

  function content({ key, pin }: LibraryListColumn) {
    switch (key) {
      case "grade": return item.grade?.replace(/H$/, "") ?? "—";
      case "artwork": return <div className="lib-list-art"><LibraryArtwork resource={resource} compact /></div>;
      case "title": return <>
        {index !== undefined && <span id={positionId} className="lib-sr">Replay {index + 1}</span>}
        <div className="lib-replay-title" title={title}>
          {title} {item.isNew && <span className="lib-new">NEW</span>}
          {!item.available && <span className="lib-file-unavailable">FILE UNAVAILABLE</span>}
        </div>
        <div className="lib-note lib-replay-subtitle" title={subtitle}>{subtitle}</div>
      </>;
      case "mods": return <LibraryReplayMods item={item} height={23} compact />;
      case "save": return <LibraryButton
        aria-label={`Add ${item.title ?? "replay"} to collection`}
        onClick={event => { event.stopPropagation(); onSelect(); onSave(event.currentTarget); }}
        onDoubleClick={event => event.stopPropagation()}
      ><LibraryIcon name="bookmark" filled={item.collectionCount > 0 || item.favourite} /></LibraryButton>;
      case "combo": return <LibraryCombo item={item} showFc={false} />;
      case "len": return libraryLength(item.values.len);
      case "date":
        if (!played) return "—";
        return pin
          ? <time dateTime={played.toISOString()}>{played.toLocaleDateString()}<br />{played.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
          : libraryRelativeDate(item.values.date);
      case "miss":
        if (confirmedFC && !pin) return <span title={libraryFullComboSource(item)} style={{ color: c.key1 }}>FC</span>;
        return libraryNumber(item.values.miss);
      case "peak":
      case "fc":
        if (confirmedFC) return <span title={libraryFullComboSource(item)} aria-label={`${key === "peak" ? "Peak" : "PP if FC"} hidden for full combo`}>{pin ? "FC" : "—"}</span>;
        break;
    }
    const value = item.values[key];
    const digits = key === "acc" || key === "sr" ? 2 : key === "ur" ? 1 : 0;
    const unit = key === "acc" ? "%" : key === "sr" ? " ★" : key === "bpm" ? " bpm" : key === "ur" ? " UR" : " pp";
    return libraryNumber(value, digits) + (pin && Number.isFinite(value) ? unit : "");
  }

  return <div
    role="row"
    aria-current={selected ? "true" : undefined}
    data-selected={selected}
    aria-label={`${title}, ${item.player ?? "Unknown player"}${item.available ? "" : ", file unavailable"}`}
    aria-describedby={index === undefined ? undefined : positionId}
    className="lib-list-row"
    tabIndex={0}
    data-replay-id={item.id}
    onClick={onSelect}
    onDoubleClick={item.available ? onOpen : onSelect}
    onKeyDown={event => {
      if (event.key === "Enter" && event.currentTarget === event.target) {
        event.preventDefault();
        if (selected && item.available) onOpen();
        else onSelect();
      }
    }}
  >
    {listColumns.map(column => <div
      key={column.key}
      role="cell"
      data-column={column.key}
      data-pin={column.pin}
      data-align={column.align}
      className={column.key === "title" ? "lib-list-title" : column.key === "grade" ? "lib-grade" : undefined}
      style={column.key === "grade" ? { color: libraryGradeColor(item) } : undefined}
      title={column.key === "date" && played ? played.toLocaleString()
        : column.sort && column.sort !== "title" && item.values[column.sort] === null ? ANALYSIS_LABELS[item.analysis] : undefined}
    >{content(column)}</div>)}
  </div>;
}
