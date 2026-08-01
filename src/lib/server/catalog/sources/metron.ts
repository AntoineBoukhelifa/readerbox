import {
	CHRONOMETRE_REEL,
	creerCadence,
	creerVeille,
	lireJson,
	parametres,
	suiteAcceptable,
	TRANSPORT_REEL,
	type Chronometre,
	type Transport
} from './http';
import { dateIso, identifiant, liste, objet, rang, texte, type Objet } from './lecture';
import type {
	AdaptateurDeSource,
	AxeDeParcours,
	CapacitesDeSource,
	Completude,
	CreateurDistant,
	EntiteDistante,
	OeuvreDistante,
	OptionsDePage,
	Page,
	ReferenceSource,
	Resultat,
	TypeOeuvre
} from './types';

/**
 * Metron — la source primaire pour les comics (décision 001).
 *
 * Tout ce que cet adaptateur suppose a été mesuré, et ce qu'il ne sait pas, il
 * le déclare absent plutôt que de l'inventer.
 *
 * **Trois faits gouvernent ce fichier.**
 *
 * 1. **La recherche passe par `series_name`, jamais par `name`.** `name` cherche
 *    dans le *titre de l'histoire* et tombe sur des numéros obscurs que la
 *    communauté n'a pas indexés : c'est l'erreur qui a fait conclure à 0 % de
 *    couverture personnages lors de la première sonde, et qui a failli amputer le
 *    graphe de sa dimension principale. Le paramètre est ici, une seule fois, et
 *    il ne bouge pas.
 * 2. **Metron étrangle vers la dizaine d'appels consécutifs**, avec douze
 *    secondes de récupération annoncées dans le corps du 429. Une cadence de
 *    2,5 s passe. L'adaptateur la tient, et traite le 429 comme un `quota` — une
 *    réponse réessayable — jamais comme une panne.
 * 3. **Un appel par recherche.** La liste porte déjà le titre, la série, la date
 *    et la couverture : ce qu'il faut pour afficher un résultat. Les personnages
 *    et les crédits demandent la fiche détaillée, qui n'est appelée qu'à la
 *    consignation (KTD1). Chercher en détaillant dix résultats coûterait
 *    vingt-cinq secondes de cadence pour une donnée que personne ne regarde.
 *
 * **Ce que l'adaptateur ne réessaie pas.** Un 429 n'est pas rejoué sur place :
 * attendre les douze secondes annoncées dans le chemin de rendu bloquerait la
 * page bien au-delà de ce qu'un membre supporte, pour une source qui vient
 * justement de dire non. La veille arme un refus immédiat jusqu'à l'échéance
 * annoncée — ce qui évite que vingt membres prolongent l'étranglement — et le
 * cache court des réponses de recherche fait le reste.
 */

export const BASE_METRON = 'https://metron.cloud/api/';

/** La cadence mesurée en U1 : 2,5 s entre départs d'appels passe sans incident. */
export const CADENCE_METRON_MS = 2500;

/**
 * Les capacités **mesurées**, une par une, contre l'API réelle.
 *
 * `contenuDesRecueils` est à `false` et c'est le point délicat : la fiche
 * détaillée porte bien un champ `reprints`, et il est mappé plus bas, mais
 * aucune série de type recueil n'a pu être trouvée pour le vérifier. Déclarer
 * une capacité qu'on n'a pas constatée ferait bâtir U5 sur une supposition ; la
 * décision 001 signale déjà ce point comme non tranché.
 */
export const CAPACITES_METRON: CapacitesDeSource = {
	rechercheParTitre: true,
	parcoursParPersonnage: true,
	parcoursParSerie: true,
	parcoursParCreateur: true,
	parcoursParEvent: true,
	contenuDesRecueils: false,
	personnagesParOeuvre: true
};

/**
 * Les types de série que Metron modélise comme des recueils.
 *
 * Metron n'a pas de type d'œuvre « recueil » : il porte l'information sur la
 * *série*, dans `series.series_type.name`, dont les neuf valeurs sont connues.
 * Celles qui restent — Single Issue, Annual, Limited Series, One-Shot, Digital
 * Chapter — sont des numéros.
 */
const SERIES_DE_RECUEIL = new Set(['Trade Paperback', 'Hardcover', 'Omnibus', 'Graphic Novel']);

/**
 * Le paramètre de filtre de chaque axe, vérifié contre l'API réelle.
 *
 * L'event est un **arc narratif** chez Metron : `arc_id`. C'est la même chose
 * sous un autre nom, et le graphe n'a pas à connaître ce vocabulaire.
 */
const FILTRES_DE_PARCOURS: Record<AxeDeParcours, string> = {
	personnage: 'character_id',
	serie: 'series_id',
	createur: 'creator_id',
	event: 'arc_id'
};

export interface OptionsMetron {
	utilisateur: string;
	motDePasse: string;
	transport?: Transport;
	chronometre?: Chronometre;
	cadenceMs?: number;
	base?: string;
}

export function creerMetron(options: OptionsMetron): AdaptateurDeSource {
	const base = options.base ?? BASE_METRON;
	const transport = options.transport ?? TRANSPORT_REEL;
	const chronometre = options.chronometre ?? CHRONOMETRE_REEL;
	const cadencer = creerCadence(options.cadenceMs ?? CADENCE_METRON_MS, chronometre);
	const veille = creerVeille(chronometre);

	const entetes = {
		Authorization: `Basic ${btoa(`${options.utilisateur}:${options.motDePasse}`)}`
	};

	/** Un appel cadencé, ou un refus immédiat si la source est en veille de quota. */
	async function appeler(url: string, signal?: AbortSignal): Promise<Resultat<unknown | null>> {
		if (veille.enVeille()) return { ok: false, motif: 'quota' };
		return cadencer(() =>
			lireJson(url, { transport, entetes, signal, surQuota: (delai) => veille.armer(delai) })
		);
	}

	/** Une page de numéros, depuis n'importe quelle requête de liste. */
	async function pageDeNumeros(
		url: string,
		pagination: OptionsDePage | undefined
	): Promise<Resultat<Page<OeuvreDistante>>> {
		const reponse = await appeler(url, pagination?.signal);
		if (!reponse.ok) return reponse;

		const elements = liste(reponse.valeur, 'results');
		if (elements === undefined) return { ok: false, motif: 'illisible' };

		const limite = pagination?.limite;
		const retenus = limite === undefined ? elements : elements.slice(0, limite);
		const suivante = texte(reponse.valeur, 'next');

		const page: Page<OeuvreDistante> = {
			elements: retenus
				.map(depuisListe)
				.filter((oeuvre): oeuvre is OeuvreDistante => oeuvre !== null)
		};
		// La suite n'est annoncée que si toute la page a été rendue : la tronquer
		// puis prétendre qu'elle continue plus loin sauterait des résultats.
		if (suivante !== undefined && retenus.length === elements.length) page.suite = suivante;

		return { ok: true, valeur: page };
	}

	return {
		nom: 'metron',
		capacites: CAPACITES_METRON,
		typesCouverts: ['numero', 'recueil'],

		async rechercher(requete, pagination) {
			// Une suite est un jeton opaque : elle rejoue la requête telle quelle,
			// sans repasser par l'interprétation du texte saisi.
			const suite = suiteAcceptable(pagination?.suite, base);
			if (suite !== null) return pageDeNumeros(suite, pagination);

			const propre = requete.trim();
			if (propre === '') return { ok: true, valeur: { elements: [] } };

			let derniere: Resultat<Page<OeuvreDistante>> = { ok: true, valeur: { elements: [] } };

			for (const tentative of interpreter(propre)) {
				const url = `${base}issue/?${parametres({
					series_name: tentative.serie,
					number: tentative.numero
				})}`;
				derniere = await pageDeNumeros(url, pagination);
				if (!derniere.ok) return derniere;
				if (derniere.valeur.elements.length > 0) return derniere;
			}

			return derniere;
		},

		async parcourir(axe, idExterne, pagination) {
			const suite = suiteAcceptable(pagination?.suite, base);
			if (suite !== null) return pageDeNumeros(suite, pagination);

			const url = `${base}issue/?${parametres({ [FILTRES_DE_PARCOURS[axe]]: idExterne })}`;
			return pageDeNumeros(url, pagination);
		},

		async lireOeuvre(idExterne, signal) {
			const reponse = await appeler(`${base}issue/${encodeURIComponent(idExterne)}/`, signal);
			if (!reponse.ok) return reponse;
			if (reponse.valeur === null) return { ok: true, valeur: null };

			const oeuvre = depuisFiche(reponse.valeur);
			return oeuvre === null ? { ok: false, motif: 'illisible' } : { ok: true, valeur: oeuvre };
		}
	};
}

/**
 * Les requêtes à essayer, dans l'ordre, pour un texte saisi par un membre.
 *
 * `series_name` fait une recherche par inclusion sur le nom de série. « Immortal
 * X-Men » rend donc les dix-huit numéros de la série, ce qui est exactement ce
 * qu'un membre attend. Mais « Immortal X-Men #1 » n'est le nom d'aucune série :
 * un numéro saisi à la fin doit passer dans le paramètre `number`, sans quoi la
 * recherche la plus naturelle du produit ne rend rien.
 *
 * D'où deux tentatives au plus, et dans cet ordre-là :
 *
 * - un `#` explicite ne laisse aucun doute : une seule requête, avec le numéro ;
 * - un entier final sans `#` est ambigu — « X-Men 92 » est un nom de série — donc
 *   le texte entier est essayé d'abord, et le découpage seulement s'il ne rend
 *   rien. Le second appel ne coûte sa cadence que sur une recherche qui aurait
 *   échoué, et le cache l'absorbe pour les membres suivants.
 */
export function interpreter(requete: string): { serie: string; numero?: string }[] {
	const explicite = /^(.+?)\s*#\s*(\d+)$/.exec(requete);
	if (explicite) return [{ serie: explicite[1].trim(), numero: explicite[2] }];

	const implicite = /^(.+\S)\s+(\d+)$/.exec(requete);
	if (implicite) return [{ serie: requete }, { serie: implicite[1], numero: implicite[2] }];

	return [{ serie: requete }];
}

// ---------------------------------------------------------------------------
// Le mappage
// ---------------------------------------------------------------------------

const reference = (idExterne: string): ReferenceSource => ({ source: 'metron', idExterne });

/**
 * Un élément de liste, tel que `/api/issue/` le rend.
 *
 * **La complétude dit « indisponibles » et non « absents », et c'est la
 * distinction qui porte tout le modèle** : la liste ne *propose* pas les
 * personnages, elle ne dit pas qu'il n'y en a pas. Marquer « absents » ferait
 * d'un résultat de recherche ingéré une œuvre définitivement dépourvue de
 * crédits ; « indisponibles » en fait une ingestion partielle et rejouable, ce
 * qui est la vérité.
 */
function depuisListe(element: Objet): OeuvreDistante | null {
	const id = identifiant(element);
	if (id === undefined) return null;

	const serie = serieDe(element);
	const oeuvre: OeuvreDistante = {
		reference: reference(id),
		type: 'numero',
		titre:
			texte(element, 'issue') ??
			titreCompose(serie?.nom, texte(element, 'number')) ??
			`Numéro ${id}`,
		personnages: [],
		createurs: [],
		contenu: [],
		completude: {
			personnages: 'indisponibles',
			createurs: 'indisponibles',
			contenu: 'sans objet'
		}
	};

	const date = dateIso(element, 'cover_date');
	if (date !== undefined) oeuvre.dateDeParution = date;
	if (serie !== undefined) oeuvre.serie = serie;
	const numero = rang(element, 'number');
	if (numero !== undefined) oeuvre.numeroDansLaSerie = numero;
	const couverture = texte(element, 'image');
	if (couverture !== undefined) oeuvre.couvertureUrl = couverture;

	return oeuvre;
}

/**
 * La fiche détaillée, seule à porter les personnages, les crédits et les arcs.
 *
 * Chaque dimension déclare sa complétude depuis la **présence du champ**, pas
 * depuis son contenu : un tableau vide veut dire que Metron affirme qu'il n'y a
 * rien — un numéro des années 60 sans crédits, lacune acceptée du projet — alors
 * qu'un champ absent veut dire que la réponse n'a pas porté l'information, ce
 * qui est un incident à rejouer. Les confondre amputerait le graphe en silence.
 */
function depuisFiche(fiche: unknown): OeuvreDistante | null {
	const id = identifiant(fiche);
	if (id === undefined) return null;

	const serie = serieDe(fiche);
	const type = typeDeSerie(fiche);
	const personnages = liste(fiche, 'characters');
	const credits = liste(fiche, 'credits');
	const arcs = liste(fiche, 'arcs');
	const reprints = liste(fiche, 'reprints');

	const completude: Completude = {
		personnages: presence(personnages),
		createurs: presence(credits),
		contenu: type === 'recueil' ? presenceDuContenu(reprints) : 'sans objet'
	};

	const oeuvre: OeuvreDistante = {
		reference: reference(id),
		type,
		titre: titreCompose(serie?.nom, texte(fiche, 'number')) ?? `Numéro ${id}`,
		personnages: (personnages ?? []).map(entiteDe).filter((p): p is EntiteDistante => p !== null),
		createurs: (credits ?? []).flatMap(createursDe),
		contenu:
			type === 'recueil'
				? (reprints ?? [])
						.map((r) => identifiant(r))
						.filter((r): r is string => r !== undefined)
						.map(reference)
				: [],
		completude
	};

	const date = dateIso(fiche, 'cover_date');
	if (date !== undefined) oeuvre.dateDeParution = date;
	if (serie !== undefined) oeuvre.serie = serie;
	const numero = rang(fiche, 'number');
	if (numero !== undefined) oeuvre.numeroDansLaSerie = numero;
	const couverture = texte(fiche, 'image');
	if (couverture !== undefined) oeuvre.couvertureUrl = couverture;

	// L'event du modèle est le premier arc narratif : le schéma n'en porte qu'un,
	// et Metron les classe du plus englobant au plus local.
	const arc = (arcs ?? []).map(entiteDe).find((a): a is EntiteDistante => a !== null);
	if (arc !== undefined) oeuvre.event = arc;

	return oeuvre;
}

/** « fournis » quand la source a répondu, « indisponibles » quand le champ manque. */
function presence(valeurs: Objet[] | undefined): 'fournis' | 'absents' | 'indisponibles' {
	if (valeurs === undefined) return 'indisponibles';
	return valeurs.length > 0 ? 'fournis' : 'absents';
}

function presenceDuContenu(valeurs: Objet[] | undefined): 'fourni' | 'absent' | 'indisponible' {
	if (valeurs === undefined) return 'indisponible';
	return valeurs.length > 0 ? 'fourni' : 'absent';
}

function serieDe(element: unknown): EntiteDistante | undefined {
	const serie = objet(element, 'series');
	if (serie === undefined) return undefined;
	return entiteDe(serie) ?? undefined;
}

function entiteDe(brut: Objet): EntiteDistante | null {
	const id = identifiant(brut);
	const nom = texte(brut, 'name');
	if (id === undefined || nom === undefined) return null;
	return { reference: reference(id), nom };
}

/**
 * Les crédits d'une fiche.
 *
 * Metron rend un créateur avec **plusieurs rôles à la fois** — encreur *et*
 * lettreur sur le même numéro — dans un tableau `role`. Le modèle local porte un
 * rôle par ligne, et sa clé primaire est `(œuvre, entité, source, rôle)` : une
 * ligne par rôle est donc la bonne forme, et n'écrase rien.
 */
function createursDe(credit: Objet): CreateurDistant[] {
	const id = identifiant(credit);
	const nom = texte(credit, 'creator');
	if (id === undefined || nom === undefined) return [];

	const roles = (liste(credit, 'role') ?? [])
		.map((r) => texte(r, 'name'))
		.filter((r): r is string => r !== undefined);

	// Un crédit sans rôle lisible reste un crédit : le créateur a travaillé sur le
	// numéro, et le perdre appauvrirait la recherche par créateur (R45).
	if (roles.length === 0) return [{ reference: reference(id), nom, role: 'non précisé' }];

	return roles.map((role) => ({ reference: reference(id), nom, role }));
}

/**
 * Le type d'œuvre, depuis le type de série que Metron déclare.
 *
 * En l'absence de l'information — c'est le cas des éléments de liste, qui ne la
 * portent pas — le repli est `numero`, de très loin le cas majoritaire. Le type
 * juste est de toute façon relu sur la fiche détaillée, seule appelée à la
 * consignation : un résultat de recherche mal typé s'affiche, il ne s'ingère pas.
 */
function typeDeSerie(fiche: unknown): TypeOeuvre {
	const serie = objet(fiche, 'series');
	const nom = texte(objet(serie, 'series_type'), 'name') ?? texte(serie, 'series_type');
	return nom !== undefined && SERIES_DE_RECUEIL.has(nom) ? 'recueil' : 'numero';
}

/** « Immortal X-Men #1 » — la forme sous laquelle Metron titre lui-même ses listes. */
function titreCompose(serie: string | undefined, numero: string | undefined): string | undefined {
	if (serie === undefined) return undefined;
	return numero === undefined ? serie : `${serie} #${numero}`;
}
