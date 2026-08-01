import { lireJson, parametres, type Transport } from './http';
import { dateIso, identifiant, liste, objet, texte, type Objet } from './lecture';
import type {
	AdaptateurDeSource,
	CapacitesDeSource,
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
 * TMDB — les films et les séries (décision 001).
 *
 * Jeton v4 en `Authorization: Bearer`. Aucun étranglement observé, latence sous
 * 530 ms, affiches disponibles pour tout ce qui a été sondé : cet adaptateur n'a
 * donc **pas de cadence**, contrairement à celui de Metron. Lui en imposer une
 * ralentirait la seule source rapide du produit pour une contrainte qui n'existe
 * pas.
 *
 * **Le casting de TMDB liste des acteurs, pas des personnages de fiction.** Le
 * champ `character` du casting porte bien « Tony Stark », mais l'identifiant qui
 * l'accompagne est celui de *Robert Downey Jr.* : rattacher le personnage à cet
 * identifiant relierait dans le graphe tous les rôles d'un même acteur, ce qui
 * est faux et invisible. Cette source ne nourrit donc pas la dimension
 * personnage — elle le déclare dans ses capacités — et les films entrent dans le
 * graphe par leur série, pas par leurs personnages.
 *
 * **Les identifiants sont préfixés par le type**, `film:1726` et `serie:3097`,
 * parce que TMDB numérote films, séries, collections et personnes dans des
 * espaces séparés : le film 1726 et la série 1726 existent tous les deux, et les
 * confondre relierait des œuvres au hasard. Le préfixe fait partie de
 * l'identifiant externe, il n'est pas un détail de transport.
 */

export const BASE_TMDB = 'https://api.themoviedb.org/3/';

/** La base des affiches. `w342` est la taille lisible en liste sans peser. */
export const BASE_AFFICHES_TMDB = 'https://image.tmdb.org/t/p/w342';

/**
 * Les capacités **mesurées**.
 *
 * `parcoursParPersonnage` et `personnagesParOeuvre` sont à `false` : c'est la
 * conclusion de la décision 001, et la déclarer ici évite que la couche
 * au-dessus interroge TMDB sur un axe qui répondrait toujours vide — ou pire,
 * qui répondrait des acteurs.
 */
export const CAPACITES_TMDB: CapacitesDeSource = {
	rechercheParTitre: true,
	parcoursParPersonnage: false,
	parcoursParSerie: true,
	parcoursParCreateur: true,
	parcoursParEvent: false,
	contenuDesRecueils: false,
	personnagesParOeuvre: false
};

/**
 * Les métiers retenus au générique.
 *
 * Un film porte cent quatre-vingts lignes d'équipe, du superviseur d'effets
 * visuels au coordinateur musical. Toutes ingérer créerait cent quatre-vingts
 * entités par film pour une recherche par créateur (R45) que personne ne fera
 * sur un chef décorateur — et la médiane de dix crédits par numéro qui borne le
 * volume d'écriture du graphe volerait en éclats sur le premier film consigné.
 * La liste retient ceux qu'un lecteur nomme.
 */
const METIERS_RETENUS = new Set([
	'Director',
	'Screenplay',
	'Writer',
	'Story',
	'Novel',
	'Comic Book',
	'Characters',
	'Producer',
	'Original Music Composer',
	'Director of Photography',
	'Editor',
	'Creator'
]);

/** Le préfixe de type d'un identifiant externe TMDB. */
type EspaceTmdb = 'film' | 'serie' | 'collection' | 'personne';

const ESPACE_PAR_TYPE: Record<'movie' | 'tv', EspaceTmdb> = { movie: 'film', tv: 'serie' };

export interface OptionsTmdb {
	jeton: string;
	transport?: Transport;
	base?: string;
}

export function creerTmdb(options: OptionsTmdb): AdaptateurDeSource {
	const base = options.base ?? BASE_TMDB;
	const transport = options.transport ?? fetch;
	const entetes = { Authorization: `Bearer ${options.jeton}` };

	const appeler = (url: string, signal?: AbortSignal) =>
		lireJson(url, { transport, entetes, signal });

	/** Une page de résultats de recherche, films et séries mêlés. */
	async function chercher(
		requete: string,
		pagination: OptionsDePage | undefined
	): Promise<Resultat<Page<OeuvreDistante>>> {
		const page = numeroDePage(pagination?.suite);
		const url = `${base}search/multi?${parametres({
			query: requete,
			include_adult: 'false',
			page
		})}`;

		const reponse = await appeler(url, pagination?.signal);
		if (!reponse.ok) return reponse;

		const elements = liste(reponse.valeur, 'results');
		if (elements === undefined) return { ok: false, motif: 'illisible' };

		// `search/multi` rend aussi des personnes, qui ne sont pas des œuvres.
		const oeuvres = elements
			.map(depuisResultat)
			.filter((oeuvre): oeuvre is OeuvreDistante => oeuvre !== null);

		const limite = pagination?.limite;
		const retenus = limite === undefined ? oeuvres : oeuvres.slice(0, limite);

		const total = nombre(reponse.valeur, 'total_pages');
		const resultat: Page<OeuvreDistante> = { elements: retenus };
		if (total !== undefined && page < total && retenus.length === oeuvres.length) {
			resultat.suite = String(page + 1);
		}

		return { ok: true, valeur: resultat };
	}

	return {
		nom: 'tmdb',
		capacites: CAPACITES_TMDB,
		typesCouverts: ['film', 'serie'],

		async rechercher(requete, pagination) {
			const propre = requete.trim();
			if (propre === '') return { ok: true, valeur: { elements: [] } };
			return chercher(propre, pagination);
		},

		/**
		 * Le parcours par facette, sur les deux axes que TMDB expose vraiment.
		 *
		 * Un axe non couvert rend une page vide plutôt qu'un échec : les capacités
		 * disent déjà qu'il ne faut pas l'appeler, et transformer un appel superflu
		 * en dégradation affichée ferait croire à une panne de source.
		 */
		async parcourir(axe, idExterne, pagination) {
			const cible = decouper(idExterne);
			if (cible === null) return { ok: true, valeur: { elements: [] } };

			if (axe === 'serie' && cible.espace === 'collection') {
				const reponse = await appeler(`${base}collection/${cible.id}`, pagination?.signal);
				if (!reponse.ok) return reponse;
				if (reponse.valeur === null) return { ok: true, valeur: { elements: [] } };

				const parts = liste(reponse.valeur, 'parts') ?? [];
				return {
					ok: true,
					valeur: {
						elements: parts
							.map((part) => depuisResultat({ media_type: 'movie', ...part }))
							.filter((oeuvre): oeuvre is OeuvreDistante => oeuvre !== null)
					}
				};
			}

			// Une série télévisée est sa propre série : le parcours rend l'œuvre
			// elle-même, ce qui est vrai tant que saisons et épisodes ne sont pas
			// modélisés — et jamais un ensemble vide qui laisserait croire au néant.
			if (axe === 'serie' && cible.espace === 'serie') {
				const oeuvre = await lireFiche(cible, pagination?.signal);
				if (!oeuvre.ok) return oeuvre;
				return {
					ok: true,
					valeur: { elements: oeuvre.valeur === null ? [] : [oeuvre.valeur] }
				};
			}

			if (axe === 'createur' && cible.espace === 'personne') {
				const reponse = await appeler(
					`${base}person/${cible.id}/combined_credits`,
					pagination?.signal
				);
				if (!reponse.ok) return reponse;
				if (reponse.valeur === null) return { ok: true, valeur: { elements: [] } };

				const crew = liste(reponse.valeur, 'crew') ?? [];
				return {
					ok: true,
					valeur: {
						elements: crew
							.filter((ligne) => METIERS_RETENUS.has(texte(ligne, 'job') ?? ''))
							.map(depuisResultat)
							.filter((oeuvre): oeuvre is OeuvreDistante => oeuvre !== null)
					}
				};
			}

			return { ok: true, valeur: { elements: [] } };
		},

		async lireOeuvre(idExterne, signal) {
			const cible = decouper(idExterne);
			if (cible === null || (cible.espace !== 'film' && cible.espace !== 'serie')) {
				return { ok: true, valeur: null };
			}
			return lireFiche(cible, signal);
		}
	};

	async function lireFiche(
		cible: { espace: EspaceTmdb; id: string },
		signal?: AbortSignal
	): Promise<Resultat<OeuvreDistante | null>> {
		const chemin = cible.espace === 'film' ? 'movie' : 'tv';
		const reponse = await appeler(
			`${base}${chemin}/${encodeURIComponent(cible.id)}?append_to_response=credits`,
			signal
		);
		if (!reponse.ok) return reponse;
		if (reponse.valeur === null) return { ok: true, valeur: null };

		const oeuvre = depuisFiche(reponse.valeur, cible.espace === 'film' ? 'film' : 'serie');
		return oeuvre === null ? { ok: false, motif: 'illisible' } : { ok: true, valeur: oeuvre };
	}
}

// ---------------------------------------------------------------------------
// Les identifiants
// ---------------------------------------------------------------------------

export function referenceTmdb(espace: EspaceTmdb, id: string | number): ReferenceSource {
	return { source: 'tmdb', idExterne: `${espace}:${id}` };
}

export function decouper(idExterne: string): { espace: EspaceTmdb; id: string } | null {
	const separe = /^(film|serie|collection|personne):(.+)$/.exec(idExterne);
	if (!separe) return null;
	return { espace: separe[1] as EspaceTmdb, id: separe[2] };
}

// ---------------------------------------------------------------------------
// Le mappage
// ---------------------------------------------------------------------------

/**
 * Un résultat de `search/multi`, de `collection/{id}` ou d'un générique de
 * personne. `null` pour tout ce qui n'est pas une œuvre — une personne, par
 * exemple, que la recherche mêle aux films.
 *
 * **La complétude déclare les personnages « absents » et non « indisponibles »,
 * et c'est un choix.** TMDB ne crédite structurellement aucun personnage de
 * fiction : l'information n'est pas manquante, elle n'existe pas chez cette
 * source. La marquer indisponible ferait de chaque film une ingestion
 * éternellement partielle, que le rattrapage rejouerait sans fin pour ne jamais
 * rien trouver. Les crédits, eux, sont bien indisponibles au niveau de la liste
 * : ils viennent de la fiche détaillée.
 */
function depuisResultat(element: Objet): OeuvreDistante | null {
	const genre = texte(element, 'media_type');
	if (genre !== 'movie' && genre !== 'tv') return null;

	const id = identifiant(element);
	if (id === undefined) return null;

	const espace = ESPACE_PAR_TYPE[genre];
	const titre = texte(element, genre === 'movie' ? 'title' : 'name');
	if (titre === undefined) return null;

	const oeuvre: OeuvreDistante = {
		reference: referenceTmdb(espace, id),
		type: genre === 'movie' ? 'film' : 'serie',
		titre,
		personnages: [],
		createurs: [],
		contenu: [],
		completude: { personnages: 'absents', createurs: 'indisponibles', contenu: 'sans objet' }
	};

	const date = dateIso(element, genre === 'movie' ? 'release_date' : 'first_air_date');
	if (date !== undefined) oeuvre.dateDeParution = date;

	const affiche = texte(element, 'poster_path');
	if (affiche !== undefined) oeuvre.couvertureUrl = `${BASE_AFFICHES_TMDB}${affiche}`;

	return oeuvre;
}

/**
 * La fiche détaillée d'un film ou d'une série.
 *
 * La série de rattachement d'un film est sa **collection** — « Iron Man
 * Collection » — qui est ce que R8 appelle une série pour l'audiovisuel. Une
 * série télévisée, elle, désigne sa propre entité : c'est ce que le schéma
 * prévoit pour l'œuvre de type `serie`, et c'est ce qui permettra à ses saisons
 * de s'y rattacher.
 */
function depuisFiche(
	fiche: unknown,
	type: Extract<TypeOeuvre, 'film' | 'serie'>
): OeuvreDistante | null {
	const id = identifiant(fiche);
	const titre = texte(fiche, type === 'film' ? 'title' : 'name');
	if (id === undefined || titre === undefined) return null;

	const espace: EspaceTmdb = type === 'film' ? 'film' : 'serie';
	const equipe = liste(objet(fiche, 'credits'), 'crew');
	const fondateurs = type === 'serie' ? liste(fiche, 'created_by') : undefined;
	const createurs = [...equipeRetenue(equipe), ...(fondateurs ?? []).flatMap(createurDeSerie)];

	const oeuvre: OeuvreDistante = {
		reference: referenceTmdb(espace, id),
		type,
		titre,
		personnages: [],
		createurs,
		contenu: [],
		completude: {
			personnages: 'absents',
			// Les créateurs viennent de `append_to_response=credits`. Si la clé
			// manque, la sous-ressource n'a pas répondu : l'œuvre est partielle et
			// rejouable, et surtout pas dépourvue de générique.
			createurs:
				equipe === undefined && fondateurs === undefined
					? 'indisponibles'
					: createurs.length > 0
						? 'fournis'
						: 'absents',
			contenu: 'sans objet'
		}
	};

	const date = dateIso(fiche, type === 'film' ? 'release_date' : 'first_air_date');
	if (date !== undefined) oeuvre.dateDeParution = date;

	const affiche = texte(fiche, 'poster_path');
	if (affiche !== undefined) oeuvre.couvertureUrl = `${BASE_AFFICHES_TMDB}${affiche}`;

	const serie = serieDe(fiche, type, id, titre);
	if (serie !== undefined) oeuvre.serie = serie;

	return oeuvre;
}

function serieDe(
	fiche: unknown,
	type: 'film' | 'serie',
	id: string,
	titre: string
): EntiteDistante | undefined {
	if (type === 'serie') return { reference: referenceTmdb('serie', id), nom: titre };

	const collection = objet(fiche, 'belongs_to_collection');
	const collectionId = identifiant(collection);
	const nom = texte(collection, 'name');
	if (collectionId === undefined || nom === undefined) return undefined;
	return { reference: referenceTmdb('collection', collectionId), nom };
}

function equipeRetenue(equipe: Objet[] | undefined): CreateurDistant[] {
	return (equipe ?? []).flatMap((ligne) => {
		const metier = texte(ligne, 'job');
		const id = identifiant(ligne);
		const nom = texte(ligne, 'name');
		if (metier === undefined || id === undefined || nom === undefined) return [];
		if (!METIERS_RETENUS.has(metier)) return [];
		return [{ reference: referenceTmdb('personne', id), nom, role: metier }];
	});
}

function createurDeSerie(ligne: Objet): CreateurDistant[] {
	const id = identifiant(ligne);
	const nom = texte(ligne, 'name');
	if (id === undefined || nom === undefined) return [];
	return [{ reference: referenceTmdb('personne', id), nom, role: 'Creator' }];
}

/** Le jeton de suite de TMDB est un numéro de page, pas une URL. */
function numeroDePage(suite: string | undefined): number {
	const lu = Number(suite ?? '1');
	return Number.isInteger(lu) && lu >= 1 && lu <= 500 ? lu : 1;
}

function nombre(valeur: unknown, champ: string): number | undefined {
	const lu = identifiant(valeur, champ);
	if (lu === undefined) return undefined;
	const converti = Number(lu);
	return Number.isFinite(converti) ? converti : undefined;
}
