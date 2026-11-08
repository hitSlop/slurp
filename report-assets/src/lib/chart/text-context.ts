// This context is used only by Vega's text metrics module. It exposes no drawing,
// DOM, or I/O capabilities; Vega retains its own caching and truncation logic.
declare const __slurpMeasureText: (text: string, family: string, size: number, weight: string, style: string, variant: string) => number;
export const context = {
  font: '11px sans-serif',
  measureText(text: string) {
    // Vega's font() emits [style] [variant] [weight] SIZEpx FAMILY in this order.
    const parsed = /^(.*?)([\d.]+(?:e[+-]?\d+)?)px (.+)$/i.exec(this.font);
    if (!parsed) throw new Error(`Unsupported chart font: ${this.font}`);
    const prefix = parsed[1].trim().split(/\s+/);
    const weight = prefix.find(token => /^(?:[\d.]+|bold|bolder|lighter|normal)$/.test(token) && token !== 'normal') || 'normal';
    const style = prefix.includes('italic') ? 'italic' : prefix.includes('oblique') ? 'oblique' : 'normal';
    const variant = prefix.includes('small-caps') ? 'small-caps' : 'normal';
    return { width: __slurpMeasureText(text, parsed[3], Number(parsed[2]), weight, style, variant) };
  },
};
