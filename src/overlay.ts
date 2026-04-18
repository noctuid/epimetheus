/**
 * Overlay component for displaying recall details.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { RecallMessageDetails } from "./index";

/**
 * Overlay component that displays recall details with scrolling support.
 * Closes on Escape or 'q' key.
 */
export class RecallOverlayComponent {
  private scrollOffset = 0;
  private contentLines: string[] = [];
  private maxContentLines: number;

  constructor(
    private theme: { fg: (color: string, text: string) => string },
    private details: RecallMessageDetails,
    private done: () => void,
    overlayOptions?: { maxHeight?: number },
  ) {
    // Calculate max content lines (reserve space for title, borders, scroll indicator, help)
    // Layout: title (2 lines) + blank (1 line) + content + blank (1 line) + help (1 line) + borders (2)
    const maxOverlayHeight = overlayOptions?.maxHeight ?? 30;
    this.maxContentLines = Math.max(5, maxOverlayHeight - 7);

    // Pre-calculate content lines
    this.contentLines = this.buildContentLines(details.memories);
  }

  /**
   * Build content lines from memories text, wrapping long lines.
   */
  private buildContentLines(memories: string): string[] {
    const lines: string[] = [];
    const memoryLines = memories.split("\n");
    // Use a reasonable width for wrapping (will be re-wrapped in render if needed)
    const wrapWidth = 76; // 80 - 2 borders - 2 padding

    for (const line of memoryLines) {
      if (visibleWidth(line) <= wrapWidth) {
        lines.push(line);
      } else {
        // Wrap long lines, preserving ANSI codes across line breaks
        const wrapped = wrapTextWithAnsi(line, wrapWidth);
        lines.push(...wrapped);
      }
    }
    return lines;
  }

  handleInput(data: string): void {
    const totalLines = this.contentLines.length;

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      // Scroll up one line
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      // Scroll down one line
      const maxOffset = Math.max(0, totalLines - this.maxContentLines);
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
      // Scroll up one page
      this.scrollOffset = Math.max(0, this.scrollOffset - this.maxContentLines);
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "f")) {
      // Scroll down one page
      const maxOffset = Math.max(0, totalLines - this.maxContentLines);
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.maxContentLines);
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    // Title
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    const title = `🧠 Hindsight recalled ${this.details.count} ${this.details.count === 1 ? "memory" : "memories"}`;
    lines.push(row(` ${th.fg("accent", title)}`));
    lines.push(row(""));

    // Calculate scroll state
    const totalLines = this.contentLines.length;
    const canScrollUp = this.scrollOffset > 0;
    const canScrollDown = this.scrollOffset < totalLines - this.maxContentLines;

    // Add scroll indicator if content overflows
    if (canScrollUp || canScrollDown) {
      const position = totalLines <= this.maxContentLines
        ? ""
        : `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.maxContentLines, totalLines)}/${totalLines}`;
      lines.push(row(th.fg("dim", ` ${position}`)));
    }

    // Render visible content lines
    const visibleLines = this.contentLines.slice(
      this.scrollOffset,
      this.scrollOffset + this.maxContentLines,
    );
    for (const line of visibleLines) {
      // Truncate if needed for actual width (wrapping is done in buildContentLines)
      const paddedLine = visibleWidth(line) <= innerW - 2 ? line : truncateToWidth(line, innerW - 2);
      lines.push(row(` ${paddedLine}`));
    }

    // Pad to maxContentLines to keep consistent height
    for (let i = visibleLines.length; i < this.maxContentLines; i++) {
      lines.push(row(""));
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "↑↓/jk scroll | PgUp/PgDn/bf page | Esc/q close")}`));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  invalidate(): void {}
}
