import type { Converter } from './base';
import { MediaWikiConverter } from './mediawiki';
import { ConfluenceConverter } from './confluence';

/**
 * Ajouter un format = créer un dossier converters/<id>/ et l'enregistrer ici.
 * Les convertisseurs non disponibles (V2) apparaissent grisés dans l'interface.
 */
export const CONVERTERS: Converter[] = [
  new MediaWikiConverter(),
  new ConfluenceConverter(),
  placeholder('dokuwiki', 'DokuWiki', 'txt', 'Prévu en V2'),
  placeholder('bookstack', 'BookStack', 'html', 'Prévu en V2'),
];

export function getConverter(id: string): Converter {
  const c = CONVERTERS.find((x) => x.id === id);
  if (!c || !c.available) throw new Error(`Format inconnu ou indisponible : ${id}`);
  return c;
}

function placeholder(id: string, label: string, extension: string, description: string): Converter {
  return {
    id,
    label,
    extension,
    description,
    available: false,
    defaultOptions: () => ({ imagePrefix: '' }),
    convert: () => {
      throw new Error(`${label} n'est pas encore disponible`);
    },
  };
}
