import * as PIXI from "pixi.js";
import { PlayfieldBorderFactory } from "./PlayfieldBorderFactory";
import { injectable } from "inversify";
import { HitObjectsContainer, HitObjectsContainerFactory } from "./HitObjectsContainerFactory";
import { CursorPreparer } from "./CursorPreparer";
import { JudgementPreparer } from "./JudgementPreparer";
import { ErrorOutlinePreparer } from "./ErrorOutlinePreparer";
import { PlayfieldBorder } from "@rewind/osu-pixi/classic-components";
import type { ClipExportOptions } from "../../../manager/clip-export-types";

export class Playfield {
  public readonly container: PIXI.Container;

  constructor(
    private readonly playfieldBorder: PlayfieldBorder,
    private readonly hitObjectsContainer: HitObjectsContainer,
    private cursorPreparer: CursorPreparer,
    private judgementPreparer: JudgementPreparer,
    private errorOutlinePreparer: ErrorOutlinePreparer,
  ) {
    this.container = new PIXI.Container();
    this.container.addChild(
      this.playfieldBorder.graphics,
      this.hitObjectsContainer.spinnerProxies,
      this.hitObjectsContainer.hitObjectContainer,
      this.hitObjectsContainer.approachCircleContainer,
      // The ring around an error's object: above the objects, below its own miss ✕.
      this.errorOutlinePreparer.container,
      // Keep classic hit results above active objects so a newly resolved MISS
      // remains readable when the next object or slider break is only a frame
      // away. Cursor analysis stays topmost.
      this.judgementPreparer.getContainer(),
      this.judgementPreparer.getComponentContainer(),
      this.cursorPreparer.getContainer(),
    );
  }

  updatePlayfield() {
    // playfieldBorder is push-based, therefore no .update()
    this.hitObjectsContainer.updateHitObjects();
    this.errorOutlinePreparer.update();
    this.cursorPreparer.updateCursors();
    this.judgementPreparer.updateJudgements();
  }

  withCaptureCursors<T>(
    options: Pick<ClipExportOptions, "showReplayCursor" | "showAnalysisCursor" | "showComparisonCursor">,
    render: () => T,
  ): T {
    return this.cursorPreparer.withCaptureCursors(options, render);
  }
}

@injectable()
export class PlayfieldFactory {
  constructor(
    private playfieldBorderFactory: PlayfieldBorderFactory,
    private hitObjectsContainerFactory: HitObjectsContainerFactory,
    private cursorPreparer: CursorPreparer,
    private judgementPreparer: JudgementPreparer,
    private errorOutlinePreparer: ErrorOutlinePreparer,
  ) {}

  createPlayfield() {
    return new Playfield(
      this.playfieldBorderFactory.createPlayfieldBorder(),
      this.hitObjectsContainerFactory.createHitObjectsContainer(),
      this.cursorPreparer,
      this.judgementPreparer,
      this.errorOutlinePreparer,
    );
  }
}
