import type { Converter } from './base';
import { MediaWikiConverter } from './mediawiki';
import { ConfluenceConverter } from './confluence';
import { ConfluenceWikiConverter } from './confluence-wiki';
import { DokuWikiConverter } from './dokuwiki';
import { MarkdownConverter } from './markdown';
import { BookStackConverter } from './bookstack';

/**
 * Ajouter un format = créer un dossier converters/<id>/ et l'enregistrer ici.
 * L'interface, le pipeline et l'export lisent ce registre ; rien d'autre à modifier.
 */
export const CONVERTERS: Converter[] = [
  new MediaWikiConverter(),
  new ConfluenceConverter(),
  new ConfluenceWikiConverter(),
  new DokuWikiConverter(),
  new MarkdownConverter(),
  new BookStackConverter(),
];

export function getConverter(id: string): Converter {
  const c = CONVERTERS.find((x) => x.id === id);
  if (!c || !c.available) throw new Error(`Format inconnu ou indisponible : ${id}`);
  return c;
}
