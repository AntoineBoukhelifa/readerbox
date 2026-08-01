/**
 * La frontière « atteint », et rien d'autre.
 *
 * Le document d'exigences distingue deux mots que le produit ne doit jamais
 * confondre : **consigner**, c'est poser une œuvre sur une étagère quelle
 * qu'elle soit ; **atteindre**, c'est l'avoir terminée ou abandonnée, et
 * seulement cela (R3). Une œuvre en « à découvrir » est consignée sans être
 * atteinte, et c'est le cas le plus fréquent du produit.
 *
 * L'état atteint est **dérivé, jamais stocké**. Le stocker à côté de l'étagère
 * ouvrirait la possibilité qu'ils divergent, et le jour où ils divergent le
 * masquage laisse fuir un texte. Il est donc calculé, et calculé **ici
 * seulement** : trois mécaniques en dépendent — le masquage (U6), la
 * progression des ordres (U7) et les appuis du graphe (U9) — et trois
 * réimplémentations finiraient par se contredire. C'est exactement le défaut
 * que le document d'origine relève chez Goodreads.
 *
 * Ce module est volontairement pur et sans dépendance : il s'importe depuis
 * n'importe où sans traîner la couche base avec lui.
 */

/** Les trois étagères de R1. L'abandon n'en est pas une (R2). */
export const ETAGERES = ['a_decouvrir', 'en_cours', 'termine'] as const;
export type Etagere = (typeof ETAGERES)[number];

/**
 * Le sens d'un franchissement de la frontière.
 *
 * « perte » plutôt que « abandon » ou « retrait » : le mot désigne la perte de
 * l'état atteint, quelle qu'en soit la cause — reprise d'une œuvre abandonnée
 * (R35), déplacement de « terminé » vers « en cours », ou retrait pur et simple
 * de la consignation (R33).
 */
export const SENS_DE_FRANCHISSEMENT = ['atteinte', 'perte'] as const;
export type SensDeFranchissement = (typeof SENS_DE_FRANCHISSEMENT)[number];

/**
 * Ce dont dépend l'atteinte, et rien de plus.
 *
 * Ni la note, ni l'avis, ni la position n'y figurent : R2 dit explicitement que
 * l'abandon n'exige ni note ni avis, et R24 fait dépendre la position de
 * l'atteinte, pas l'inverse.
 */
export interface EtatDeLecture {
	etagere: Etagere;
	abandonnee: boolean;
}

/**
 * R3 — une œuvre est atteinte quand elle est terminée ou abandonnée, et
 * seulement alors.
 *
 * L'abandon l'emporte sur l'étagère parce que c'est un quatrième état distinct
 * des trois (R2) : abandonner une œuvre qu'on n'avait même pas commencée reste
 * un abandon, donc une atteinte.
 */
export function estAtteinte(etat: EtatDeLecture): boolean {
	return etat.abandonnee || etat.etagere === 'termine';
}

/**
 * Le franchissement entre deux états, `null` désignant l'absence d'entrée —
 * avant la consignation, ou après le retrait.
 *
 * Le franchissement se lit sur le prédicat, jamais sur les champs : passer de
 * « terminé » à « abandonné » change l'entrée sans franchir quoi que ce soit,
 * et notifier le graphe à cette occasion lui ferait rejouer des appuis
 * identiques pour rien.
 */
export function franchissement(
	avant: EtatDeLecture | null,
	apres: EtatDeLecture | null
): SensDeFranchissement | null {
	const atteinteAvant = avant !== null && estAtteinte(avant);
	const atteinteApres = apres !== null && estAtteinte(apres);

	if (atteinteAvant === atteinteApres) return null;
	return atteinteApres ? 'atteinte' : 'perte';
}
