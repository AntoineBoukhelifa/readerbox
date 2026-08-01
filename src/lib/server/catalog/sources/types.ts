/**
 * L'interface commune des sources de catalogue.
 *
 * C'est la pièce la plus importante de U1 : elle existe pour qu'un changement
 * de fournisseur ne touche qu'un fichier. Comic Vine porte la meilleure donnée
 * d'apparition de personnages et le pire pronostic de pérennité — on construit
 * donc en supposant qu'il faudra en changer.
 *
 * Deux partis pris qui traversent tout ce fichier :
 *
 * 1. Rien ne lève d'exception pour un échec attendu. Un quota épuisé ou une
 *    source en panne sont des réponses, pas des accidents — le produit doit
 *    dégrader proprement sans faire échouer la page.
 * 2. Une donnée absente et une donnée indisponible ne se confondent jamais. Un
 *    numéro des années 60 sans liste de personnages est une lacune acceptée du
 *    projet ; le même numéro dont la requête a échoué est un incident à rejouer.
 *    Les traiter pareil rendrait le graphe silencieusement amputé.
 */

export type NomDeSource = 'metron' | 'comicvine' | 'tmdb';

export type TypeOeuvre = 'numero' | 'recueil' | 'film' | 'serie' | 'saison' | 'episode' | 'roman';

/** L'identité d'une entité chez une source donnée. */
export interface ReferenceSource {
	source: NomDeSource;
	idExterne: string;
}

/** Un personnage, une série ou un event, tels que la source les nomme. */
export interface EntiteDistante {
	reference: ReferenceSource;
	nom: string;
}

export interface CreateurDistant extends EntiteDistante {
	/** Scénario, dessin, encrage… tel que la source le libelle. */
	role: string;
}

/**
 * Ce que la source a réellement fourni, champ par champ.
 *
 * C'est ce qui alimente l'état d'ingestion de U3a. Sans cette distinction, une
 * requête partiellement échouée produit une œuvre à zéro personnage,
 * indiscernable d'une œuvre réellement dépourvue de crédits.
 */
export interface Completude {
	personnages: 'fournis' | 'absents' | 'indisponibles';
	createurs: 'fournis' | 'absents' | 'indisponibles';
	/** « sans objet » pour tout ce qui n'est pas un recueil ou une saison. */
	contenu: 'fourni' | 'absent' | 'indisponible' | 'sans objet';
}

export interface OeuvreDistante {
	reference: ReferenceSource;
	type: TypeOeuvre;
	titre: string;
	/** ISO 8601, jour compris quand la source le donne. */
	dateDeParution?: string;
	serie?: EntiteDistante;
	numeroDansLaSerie?: number;
	event?: EntiteDistante;
	personnages: EntiteDistante[];
	createurs: CreateurDistant[];
	couvertureUrl?: string;
	/** Pour un recueil ou une saison : ce qu'il contient. Vide sinon. */
	contenu: ReferenceSource[];
	completude: Completude;
}

export type MotifEchec =
	/** Quota ou limite de débit atteinte. Réessayable plus tard. */
	| 'quota'
	/** Source injoignable ou en erreur. Réessayable. */
	| 'indisponible'
	/** Clé absente, invalide ou droits insuffisants. Pas réessayable seul. */
	| 'non-autorise'
	/** La source a répondu quelque chose qu'on ne sait pas lire. */
	| 'illisible';

export type Resultat<T> = { ok: true; valeur: T } | { ok: false; motif: MotifEchec };

export interface Page<T> {
	elements: T[];
	/** Jeton opaque à repasser tel quel pour la page suivante. */
	suite?: string;
}

export interface OptionsDePage {
	suite?: string;
	limite?: number;
	signal?: AbortSignal;
}

/**
 * Ce qu'une source sait faire.
 *
 * Aucune source ne couvre tous les axes, et U1 sert précisément à mesurer
 * lesquels. Déclarer les capacités plutôt que de les supposer évite que la
 * couche au-dessus appelle une méthode qui répondra toujours vide.
 */
export interface CapacitesDeSource {
	rechercheParTitre: boolean;
	parcoursParPersonnage: boolean;
	parcoursParSerie: boolean;
	parcoursParCreateur: boolean;
	parcoursParEvent: boolean;
	/** La source expose-t-elle les numéros que contient un recueil ? U5 en dépend entièrement. */
	contenuDesRecueils: boolean;
	/** La source crédite-t-elle les personnages par œuvre ? Le graphe en dépend entièrement. */
	personnagesParOeuvre: boolean;
}

export type AxeDeParcours = 'personnage' | 'serie' | 'createur' | 'event';

export interface AdaptateurDeSource {
	readonly nom: NomDeSource;
	readonly capacites: CapacitesDeSource;

	/** Les types d'œuvre que cette source couvre — TMDB ne connaît pas les numéros. */
	readonly typesCouverts: readonly TypeOeuvre[];

	rechercher(requete: string, options?: OptionsDePage): Promise<Resultat<Page<OeuvreDistante>>>;

	/**
	 * Parcours par facette. C'est ce qui fait vivre R46 : sans lui, la découverte
	 * se limite à ce que le groupe a déjà consigné.
	 */
	parcourir(
		axe: AxeDeParcours,
		idExterne: string,
		options?: OptionsDePage
	): Promise<Resultat<Page<OeuvreDistante>>>;

	/** Une œuvre complète, avec ses rattachements. `null` si la source ne la connaît pas. */
	lireOeuvre(idExterne: string, signal?: AbortSignal): Promise<Resultat<OeuvreDistante | null>>;
}

/** Une œuvre dont tous les champs facultatifs sont absents, pour construire proprement. */
export function oeuvreVide(
	reference: ReferenceSource,
	type: TypeOeuvre,
	titre: string
): OeuvreDistante {
	return {
		reference,
		type,
		titre,
		personnages: [],
		createurs: [],
		contenu: [],
		completude: {
			personnages: 'absents',
			createurs: 'absents',
			contenu: type === 'recueil' || type === 'saison' ? 'absent' : 'sans objet'
		}
	};
}
