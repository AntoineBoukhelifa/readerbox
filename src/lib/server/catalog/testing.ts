import { members } from '../db/schema';
import type { Db } from '../db';
import {
	oeuvreVide,
	type EntiteDistante,
	type NomDeSource,
	type OeuvreDistante,
	type ReferenceSource,
	type TypeOeuvre
} from './sources/types';

/**
 * Les fabriques de fixtures du catalogue.
 *
 * U3b — les adaptateurs de source — est bloquée sur des clés d'API que nous
 * n'avons pas. Les tests de U3a saisissent donc les œuvres directement, sous la
 * forme exacte qu'un adaptateur produira : `OeuvreDistante`. Le jour où les
 * adaptateurs existeront, rien de ce qui est testé ici ne bougera.
 */

export const T0 = 1_700_000_000_000;
export const UN_JOUR = 24 * 60 * 60 * 1000;

export function reference(source: NomDeSource, idExterne: string): ReferenceSource {
	return { source, idExterne };
}

export function entite(source: NomDeSource, idExterne: string, nom: string): EntiteDistante {
	return { reference: reference(source, idExterne), nom };
}

type ChampsOeuvre = Partial<Omit<OeuvreDistante, 'reference' | 'completude'>> & {
	completude?: Partial<OeuvreDistante['completude']>;
};

/**
 * Une œuvre amont plausible.
 *
 * La complétude suit ce que le test déclare : fournir une liste de personnages
 * la marque « fournis », ne rien fournir la laisse « absents ». Un test qui
 * veut simuler un échec de sous-ressource le dit explicitement — c'est
 * précisément la distinction que le modèle existe pour porter.
 */
export function oeuvreDistante(
	source: NomDeSource,
	idExterne: string,
	champs: ChampsOeuvre = {}
): OeuvreDistante {
	const type: TypeOeuvre = champs.type ?? 'numero';
	const base = oeuvreVide(reference(source, idExterne), type, champs.titre ?? 'Sans titre');

	return {
		...base,
		...champs,
		completude: {
			personnages: champs.personnages?.length ? 'fournis' : base.completude.personnages,
			createurs: champs.createurs?.length ? 'fournis' : base.completude.createurs,
			contenu: champs.contenu?.length ? 'fourni' : base.completude.contenu,
			...champs.completude
		}
	};
}

/** Un membre, sans passer par l'invitation : ce n'est pas ce qu'on teste ici. */
export async function membre(db: Db, displayName = 'Antoine', now = T0): Promise<string> {
	const [ligne] = await db
		.insert(members)
		.values({ displayName, createdAt: now })
		.returning({ id: members.id });
	return ligne.id;
}
