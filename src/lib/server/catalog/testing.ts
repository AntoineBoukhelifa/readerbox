import { members } from '../db/schema';
import type { Db } from '../db';
import {
	oeuvreVide,
	type AdaptateurDeSource,
	type AxeDeParcours,
	type CapacitesDeSource,
	type EntiteDistante,
	type MotifEchec,
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

const CAPACITES_COMPLETES: CapacitesDeSource = {
	rechercheParTitre: true,
	parcoursParPersonnage: true,
	parcoursParSerie: true,
	parcoursParCreateur: true,
	parcoursParEvent: true,
	contenuDesRecueils: true,
	personnagesParOeuvre: true
};

export interface AdaptateurFactice extends AdaptateurDeSource {
	/** Les appels réellement partis vers la « source » — ce qu'un cache doit faire tomber à zéro. */
	appels: { quoi: 'rechercher' | 'parcourir' | 'lireOeuvre'; argument: string }[];
}

/**
 * Un adaptateur de source contrôlé, pour éprouver la couche de recherche sans
 * dépendre de la forme d'une API réelle.
 *
 * Les adaptateurs concrets sont testés séparément contre des fixtures capturées ;
 * ici, ce qui compte est la **règle** — le local ne coupe jamais l'amont, une
 * source qui échoue dégrade — et elle doit se lire sans un octet de JSON Metron.
 */
export function adaptateurFactice(options: {
	nom?: NomDeSource;
	resultats?: OeuvreDistante[];
	parcours?: OeuvreDistante[];
	fiches?: Record<string, OeuvreDistante | null>;
	/** Quand il est posé, tout appel rend cet échec. */
	echec?: MotifEchec;
	capacites?: Partial<CapacitesDeSource>;
	typesCouverts?: readonly TypeOeuvre[];
}): AdaptateurFactice {
	const appels: AdaptateurFactice['appels'] = [];
	const echec = options.echec;

	return {
		nom: options.nom ?? 'metron',
		capacites: { ...CAPACITES_COMPLETES, ...options.capacites },
		typesCouverts: options.typesCouverts ?? ['numero'],
		appels,

		async rechercher(requete: string) {
			appels.push({ quoi: 'rechercher', argument: requete });
			if (echec) return { ok: false, motif: echec };
			return { ok: true, valeur: { elements: options.resultats ?? [] } };
		},

		async parcourir(axe: AxeDeParcours, idExterne: string) {
			appels.push({ quoi: 'parcourir', argument: `${axe}:${idExterne}` });
			if (echec) return { ok: false, motif: echec };
			return { ok: true, valeur: { elements: options.parcours ?? [] } };
		},

		async lireOeuvre(idExterne: string) {
			appels.push({ quoi: 'lireOeuvre', argument: idExterne });
			if (echec) return { ok: false, motif: echec };
			return { ok: true, valeur: options.fiches?.[idExterne] ?? null };
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
