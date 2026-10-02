/**
 * The exports this browser makes itself, as opposed to the ones the service renders.
 *
 * The contract splits them deliberately: Markdown, CSV and SMILES are the service's
 * (`GET …/export.{fmt}`, formula-injection-guarded server side), while **SDF** and **SVG** are
 * made here — an SDF needs a molblock, which needs RDKit, which this app already ships and the
 * service was asked not to grow a new path for; an SVG of a chart is a serialisation of a drawing
 * that only exists in this page.
 */

import { molblockOf } from '../../chem/rdkit.ts';
import type { StructureItem } from '../../../shared/exhibits.ts';

/**
 * An SDF of the items — one record per structure, each label as the record's title line and each
 * property as an SDF data field — or the SMILES RDKit could not turn into a molblock.
 *
 * All or nothing: a file silently missing three of forty structures is a file somebody imports and
 * trusts. If any item has no molblock, nothing is written and the caller says which, so the chemist
 * can take the SMILES export instead.
 */
export async function sdfOf(
  items: readonly StructureItem[],
): Promise<{ sdf: string } | { unreadable: string[] }> {
  const blocks = await Promise.all(items.map((item) => molblockOf(item.smiles)));
  const unreadable = items.filter((_, i) => !blocks[i]).map((item) => item.smiles);
  if (unreadable.length > 0) return { unreadable };
  const records = items.map((item, i) => {
    // The molblock's first line is its title; RDKit leaves it empty, and the label is the name a
    // chemist will look for in the other package. A newline in a label would shift every line of
    // the fixed-format block below it, so it is flattened.
    const lines = (blocks[i] ?? '').split('\n');
    lines[0] = item.label.replace(/[\r\n]+/g, ' ');
    const fields = Object.entries(item.props).map(
      ([key, value]) =>
        `>  <${key.replace(/[<>\r\n]/g, '_')}>\n${String(value).replace(/\r?\n/g, ' ')}\n`,
    );
    return `${lines.join('\n').replace(/\n*$/, '\n')}${fields.join('\n')}${fields.length ? '\n' : ''}$$$$`;
  });
  return { sdf: `${records.join('\n')}\n` };
}

/**
 * A standalone SVG file of a drawing on this page.
 *
 * The chart draws with token classes (`stroke-brand`, `fill-current text-ink-subtle`), which mean
 * nothing outside this stylesheet — exported as-is, every mark would be black-on-nothing or
 * invisible. So the *computed* stroke, fill and colour of every element are written inline on a
 * clone before it is serialised: the file looks like the screen, in the theme the reader exported
 * it from, and needs nothing else to open.
 */
export function svgFileOf(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [svg, ...svg.querySelectorAll('*')];
  const target = [clone, ...clone.querySelectorAll('*')];
  source.forEach((node, i) => {
    const copy = target[i];
    if (!(copy instanceof Element)) return;
    const style = window.getComputedStyle(node);
    for (const property of ['fill', 'stroke', 'color', 'fill-opacity', 'opacity', 'font-family']) {
      const value = style.getPropertyValue(property);
      if (value) (copy as SVGElement).style.setProperty(property, value);
    }
    copy.removeAttribute('class');
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

/** A filename stem from an artefact's title: what a chemist typed, minus what a filesystem minds. */
export const fileStem = (title: string, fallback: string): string =>
  title
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .trim()
    .slice(0, 80) || fallback;
