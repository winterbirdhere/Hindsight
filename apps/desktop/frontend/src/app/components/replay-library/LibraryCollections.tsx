import { useEffect, useRef, useState } from "react";
import type { LibraryCollectionCount } from "../../../../../shared/library-query";
import type { ReplayLibraryViewProps } from "./library-view-types";
import { LibraryButton, LibraryIcon, LibraryPopover } from "./library-view-controls";
const PALETTE = ["#e8829b", "#b9a2ff", "#e9c46a", "#7fb8e6", "#8fd1c3", "#f2a65e"];
export const collectionColor = (index: number) => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
type CollectionProps = Pick<
  ReplayLibraryViewProps,
  "collections" | "onCollectionCreate" | "onCollectionRename" | "onCollectionDelete"
>;
export function LibraryCollectionCreate({
  parentId,
  replayId,
  onCollectionCreate,
  onClose,
}: Pick<CollectionProps, "onCollectionCreate"> & { parentId: string | null; replayId?: string; onClose(): void }) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const create = () => {
    if (!name.trim()) return;
    onCollectionCreate(name.trim(), parentId, replayId);
    onClose();
  };
  return (
    <div
      className="lib-row"
      style={{ margin: "6px 0" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        autoFocus
        ref={input}
        aria-label="New collection name"
        placeholder="Collection name"
        value={name}
        style={{ width: "100%" }}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            create();
          }
        }}
      />
      <LibraryButton className="lib-primary" disabled={!name.trim()} onClick={create}>
        Create
      </LibraryButton>
    </div>
  );
}
export function LibraryCollections({
  collections,
  query,
  onScope,
  onCollectionCreate,
  onCollectionRename,
  onCollectionDelete,
}: CollectionProps & Pick<ReplayLibraryViewProps, "query"> & { onScope(id: string): void }) {
  const [create, setCreate] = useState<{ parentId: string | null; anchor: HTMLElement } | null>(null);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const renameCancelled = useRef(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameAnchor = useRef<HTMLElement | null>(null);
  const renameId = rename?.id;
  useEffect(() => {
    if (renameId) renameInput.current?.focus();
  }, [renameId]);
  const [menu, setMenu] = useState<{ collection: LibraryCollectionCount; anchor: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const ordered = collections
    .filter((c) => c.parentId === null)
    .flatMap((parent) => [parent, ...collections.filter((c) => c.parentId === parent.id)]);
  const commitRename = () => {
    if (renameCancelled.current) return;
    renameCancelled.current = true;
    if (rename?.name.trim()) onCollectionRename(rename.id, rename.name.trim());
    setRename(null);
  };
  const closeCreate = () => {
    const anchor = create?.anchor;
    setCreate(null);
    requestAnimationFrame(() => anchor?.isConnected && anchor.focus());
  };
  return (
    <>
      <div className="lib-row" style={{ margin: "18px 4px 5px 10px" }}>
        <span className="lib-label lib-spacer">Collections</span>
        <LibraryButton
          aria-label="New collection"
          onClick={(event) => setCreate({ parentId: null, anchor: event.currentTarget })}
        >
          <LibraryIcon name="plus" />
        </LibraryButton>
      </div>
      {create && (
        <LibraryCollectionCreate
          parentId={create.parentId}
          onCollectionCreate={onCollectionCreate}
          onClose={closeCreate}
        />
      )}
      {ordered
        .filter((c) => !c.parentId || !collapsed.has(c.parentId))
        .map((collection) => (
          <div
            key={collection.id}
            className="lib-row lib-collection"
            style={{ paddingLeft: collection.parentId ? 20 : 0, gap: 0 }}
          >
            {!collection.parentId && collections.some((c) => c.parentId === collection.id) && (
              <LibraryButton
                aria-label={`${collapsed.has(collection.id) ? "Expand" : "Collapse"} ${collection.name}`}
                style={{ padding: 0, width: 20 }}
                onClick={() =>
                  setCollapsed((old) => {
                    const next = new Set(old);
                    if (next.has(collection.id)) next.delete(collection.id);
                    else next.add(collection.id);
                    return next;
                  })
                }
              >
                <LibraryIcon name={collapsed.has(collection.id) ? "chevron" : "down"} />
              </LibraryButton>
            )}
            {rename?.id === collection.id ? (
              <input
                autoFocus
                ref={renameInput}
                aria-label="Rename collection"
                value={rename.name}
                style={{ width: "100%" }}
                onChange={(e) => setRename({ ...rename, name: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                    requestAnimationFrame(() => renameAnchor.current?.focus());
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    renameCancelled.current = true;
                    setRename(null);
                    requestAnimationFrame(() => renameAnchor.current?.focus());
                  }
                }}
              />
            ) : (
              <LibraryButton
                className="lib-scope lib-spacer"
                aria-current={
                  query.scope?.kind === "collection" && query.scope.id === collection.id ? "page" : undefined
                }
                onClick={() => onScope(collection.id)}
              >
                <span style={{ flex: "0 0 3px", height: 14, background: collectionColor(collection.paletteIndex) }} />
                <span
                  className="lib-spacer"
                  title={collection.name}
                  style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {collection.name}
                </span>
                <span className="lib-mono lib-muted lib-collection-count">{collection.count.toLocaleString()}</span>
              </LibraryButton>
            )}
            <LibraryButton
              className="lib-collection-options"
              aria-label={`Options for ${collection.name}`}
              aria-expanded={menu?.collection.id === collection.id}
              onClick={(e) => {
                setMenu({ collection, anchor: e.currentTarget });
                setDeleting(false);
              }}
            >
              <LibraryIcon name="more" />
            </LibraryButton>
          </div>
        ))}
      {menu && (
        <LibraryPopover
          title={deleting ? `Delete ${menu.collection.name}?` : menu.collection.name}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
        >
          {deleting ? (
            <>
              <p>
                Its {menu.collection.childCount !== undefined ? `${menu.collection.childCount.toLocaleString()} ` : ""}
                sub-collections go too. The {menu.collection.count.toLocaleString()} replays in it stay in your library;
                no replay files are deleted.
              </p>
              <div className="lib-row">
                <LibraryButton data-initial-focus onClick={() => setMenu(null)}>
                  Cancel
                </LibraryButton>
                <LibraryButton
                  className="lib-danger"
                  onClick={() => {
                    onCollectionDelete(menu.collection.id);
                    setMenu(null);
                  }}
                >
                  Delete collection
                </LibraryButton>
              </div>
            </>
          ) : (
            <>
              {!menu.collection.parentId && (
                <LibraryButton
                  className="lib-menu-item"
                  onClick={() => {
                    setCreate({ parentId: menu.collection.id, anchor: menu.anchor });
                    setMenu(null);
                  }}
                >
                  New collection inside
                </LibraryButton>
              )}
              <LibraryButton
                className="lib-menu-item"
                onClick={() => {
                  renameCancelled.current = false;
                  renameAnchor.current = menu.anchor;
                  setRename({ id: menu.collection.id, name: menu.collection.name });
                  setMenu(null);
                }}
              >
                Rename
              </LibraryButton>
              <LibraryButton className="lib-menu-item" onClick={() => setDeleting(true)}>
                Delete…
              </LibraryButton>
            </>
          )}
        </LibraryPopover>
      )}
    </>
  );
}
export function LibraryMemberships({
  item,
  collections,
  memberships,
  collectionsNext,
  onLoadMoreCollections,
  onLoadMoreMemberships,
  anchor,
  onClose,
  onFavourite,
  onMembership,
  onCollectionCreate,
}: Pick<
  ReplayLibraryViewProps,
  | "collections"
  | "memberships"
  | "collectionsNext"
  | "onLoadMoreCollections"
  | "onLoadMoreMemberships"
  | "onFavourite"
  | "onMembership"
  | "onCollectionCreate"
> & { item: NonNullable<ReplayLibraryViewProps["selected"]>["item"]; anchor: HTMLElement; onClose(): void }) {
  const [creating, setCreating] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const matching = memberships?.replayId === item.id ? memberships : undefined;
  const ids = new Set([...item.collectionIds, ...(matching?.ids ?? [])]);
  const complete = matching?.complete ?? item.collectionCount <= ids.size;
  return (
    <LibraryPopover title="Save to" anchor={anchor} onClose={onClose}>
      <label className="lib-check">
        <input type="checkbox" checked={item.favourite} onChange={(e) => onFavourite(item.id, e.target.checked)} />
        Favourites
      </label>
      {collections
        .filter((c) => c.parentId === null)
        .flatMap((parent) => [parent, ...collections.filter((c) => c.parentId === parent.id)])
        .map((c) => (
          <label className="lib-check" key={c.id} style={{ paddingLeft: c.parentId ? 18 : 0 }}>
            <input
              type="checkbox"
              aria-label={c.parentId ? `${collections.find((p) => p.id === c.parentId)?.name} › ${c.name}` : c.name}
              checked={ids.has(c.id)}
              ref={(node) => {
                if (node) node.indeterminate = !complete && !ids.has(c.id);
              }}
              aria-checked={!complete && !ids.has(c.id) ? "mixed" : ids.has(c.id)}
              disabled={!complete && !ids.has(c.id)}
              onChange={(e) => onMembership(item.id, c.id, e.target.checked)}
            />
            <span style={{ width: 3, height: 14, background: collectionColor(c.paletteIndex) }} />
            {c.name}
            {!complete && !ids.has(c.id) && <span className="lib-note"> · Checking membership</span>}
          </label>
        ))}
      {!complete && (
        <LibraryButton disabled={matching?.loading} onClick={onLoadMoreMemberships}>
          {matching?.loading ? "Reading memberships…" : "Load remaining memberships"}
        </LibraryButton>
      )}
      {collectionsNext && <LibraryButton onClick={onLoadMoreCollections}>More collections</LibraryButton>}
      {creating ? (
        <LibraryCollectionCreate
          parentId={null}
          replayId={item.id}
          onCollectionCreate={onCollectionCreate}
          onClose={() => {
            setCreating(false);
            requestAnimationFrame(() => createButton.current?.focus());
          }}
        />
      ) : (
        <button type="button" ref={createButton} className="lib-button lib-menu-item" onClick={() => setCreating(true)}>
          <LibraryIcon name="plus" />
          New collection…
        </button>
      )}
    </LibraryPopover>
  );
}
