/**
 * La progression dans un ordre, et rien d'autre.
 *
 * **KTD8 — la progression n'est jamais stockée.** Elle se dérive de
 * l'intersection entre les entrées d'un ordre et les œuvres que le membre a
 * atteintes (R19). C'est ce qui rend l'insertion, le retrait et le
 * réordonnancement sans danger pour les suiveurs (R16), et ce qui rend R36
 * trivial : cesser de suivre ne peut rien perdre, puisqu'il n'y avait rien à
 * perdre.
 *
 * La garantie porte sur **l'ensemble atteint, pas sur la stabilité du
 * pourcentage affiché**, et la nuance n'est pas une réserve juridique. Insérer
 * une entrée essentielle non atteinte fait mécaniquement baisser le pourcentage
 * d'un suiveur sans qu'il ait rien perdu : le dénominateur a grandi, l'ensemble
 * de ce qu'il a lu est identique au caractère près. AE6 parle de l'ensemble, et
 * `atteintes` ci-dessous est cet ensemble.
 *
 * Ce module est **pur et sans base**, pour la même raison qu'`atteinte.ts` :
 * trois surfaces le consultent — la page d'un ordre, la page d'un membre, la
 * liste des suiveurs de R22 — et trois réimplémentations finiraient par se
 * contredire. Il s'importe de n'importe où et se teste sans harnais.
 */

/**
 * Une entrée d'ordre, réduite à ce dont le calcul a besoin.
 *
 * Ni le titre, ni la date, ni l'auteur : ils n'entrent pas dans la décision.
 * L'identité (R15) y est, le rang aussi — mais le rang ne sert **qu'à ordonner
 * la séquence** pour désigner l'entrée suivante (R20), jamais à mesurer
 * l'avancement.
 */
export interface EntreeDOrdre {
	/** R15 — stable, indépendante du rang. */
	id: string;
	oeuvreId: string;
	/** Un attribut, jamais l'identité. */
	rang: number;
	/** R18 — hors du dénominateur. */
	facultative: boolean;
	/**
	 * L'œuvre a disparu du catalogue — fusion de doublons, nettoyage amont.
	 *
	 * Traitée exactement comme une entrée facultative, et pour la même raison :
	 * une œuvre absente du catalogue ne peut plus jamais être atteinte, donc la
	 * compter au dénominateur épinglerait tous les suiveurs sous 100 % sans
	 * qu'aucun geste de leur part n'y change quoi que ce soit. Seul l'auteur peut
	 * corriger, et le produit doit rester juste en attendant qu'il le fasse.
	 */
	introuvable?: boolean;
}

export interface Progression {
	/**
	 * R19 — **l'ensemble** des entrées dont l'œuvre est atteinte, facultatives
	 * comprises, dans l'ordre de la séquence.
	 *
	 * C'est la progression au sens strict du document d'exigences. Le pourcentage
	 * ci-dessous n'en est qu'un affichage, et c'est cet ensemble-ci — pas lui —
	 * qu'AE6 demande de préserver à travers une insertion.
	 */
	atteintes: string[];
	/** Le dénominateur : les entrées essentielles et atteignables. */
	essentielles: number;
	essentiellesAtteintes: number;
	/**
	 * R20 — le pourcentage d'entrées essentielles atteintes, dans [0, 100].
	 *
	 * **`null` quand le dénominateur est nul**, c'est-à-dire pour un ordre vide,
	 * un ordre entièrement facultatif, ou un ordre dont toutes les œuvres
	 * essentielles ont disparu du catalogue. Ni 0 % ni 100 % ne seraient vrais :
	 * 0 % dirait qu'il reste tout à faire à qui n'a plus rien à faire, et 100 %
	 * féliciterait d'un parcours accompli le membre qui vient d'ouvrir un ordre
	 * vide. `null` est la seule valeur honnête, et la rendre explicite oblige
	 * chaque surface à décider ce qu'elle affiche au lieu de propager un zéro
	 * trompeur.
	 */
	pourcentage: number | null;
	/**
	 * R20 — la première entrée essentielle non atteinte dans l'ordre de la
	 * séquence. `null` quand il n'en reste aucune.
	 *
	 * Une entrée facultative n'est **jamais** proposée : la proposer reviendrait à
	 * la rendre obligatoire par l'interface après l'avoir déclarée facultative par
	 * le modèle.
	 */
	entreeSuivante: EntreeDOrdre | null;
	/** Le nombre total d'entrées, facultatives comprises. Pour l'affichage seul. */
	total: number;
}

/** Une entrée compte-t-elle au dénominateur de R20 ? */
function compteAuDenominateur(entree: EntreeDOrdre): boolean {
	return !entree.facultative && entree.introuvable !== true;
}

/**
 * La progression d'un membre dans un ordre.
 *
 * `oeuvresAtteintes` est l'ensemble des œuvres que ce membre a atteintes — au
 * sens de `journal/atteinte.ts`, terminées ou abandonnées, et rien d'autre. Le
 * suivi de l'ordre n'entre pas dans le calcul : un membre qui ne suit pas un
 * ordre a malgré tout une progression dedans, ce qui est exactement ce que R36
 * exige au moment où il le suit à nouveau.
 *
 * Le tri par rang est fait ici plutôt que supposé de l'appelant : c'est la seule
 * chose pour laquelle le rang sert, et la laisser à la charge de trois surfaces
 * serait le meilleur moyen de voir l'entrée suivante diverger de l'une à
 * l'autre.
 */
export function calculerProgression(
	entrees: readonly EntreeDOrdre[],
	oeuvresAtteintes: ReadonlySet<string>
): Progression {
	const sequence = [...entrees].sort((a, b) => a.rang - b.rang);

	const estAtteinte = (entree: EntreeDOrdre) =>
		entree.introuvable !== true && oeuvresAtteintes.has(entree.oeuvreId);

	const essentielles = sequence.filter(compteAuDenominateur);
	const essentiellesAtteintes = essentielles.filter(estAtteinte).length;

	return {
		atteintes: sequence.filter(estAtteinte).map((entree) => entree.id),
		essentielles: essentielles.length,
		essentiellesAtteintes,
		pourcentage:
			essentielles.length === 0 ? null : (essentiellesAtteintes / essentielles.length) * 100,
		entreeSuivante: essentielles.find((entree) => !estAtteinte(entree)) ?? null,
		total: sequence.length
	};
}

/**
 * Le pourcentage tel qu'on l'écrit à l'écran, ou `null` s'il n'y en a pas.
 *
 * Arrondi ici et pas dans `calculerProgression` : le modèle garde la valeur
 * exacte, parce qu'un arrondi rangé dans la donnée est un arrondi qu'on finit
 * par arrondir deux fois.
 */
export function pourcentageAffiche(progression: Progression): number | null {
	return progression.pourcentage === null ? null : Math.round(progression.pourcentage);
}
