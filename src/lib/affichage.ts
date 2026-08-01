/**
 * Le vocabulaire d'affichage partagé entre les composants.
 *
 * Il tient dans un module à part plutôt que dans l'un des composants : un type
 * exporté depuis un `.svelte` n'est pas une chose sur laquelle s'appuyer, et
 * celui-ci est lu par la grille, l'affiche et les surfaces de catalogue.
 */

/**
 * L'état d'une œuvre pour le membre qui regarde, tel qu'une affiche le rend.
 *
 * Les trois valeurs sont exactement la distinction du produit :
 *
 * - `atteint` — terminée ou abandonnée (R3). Le seul état qui donne droit de
 *   voir les textes, qui fait avancer un ordre et qui alimente le graphe.
 * - `consigne` — posée sur une étagère, pas atteinte. À découvrir, ou en cours.
 * - `aucun` — sur aucune étagère.
 *
 * C'est l'or qui porte `atteint`, et lui seul : c'est là qu'est toute la
 * différence, et une interface qui les rendrait pareils raterait le produit.
 */
export type EtatDAffiche = 'atteint' | 'consigne' | 'aucun';

/** Les trois étagères de R1, dans l'ordre où on les lit. L'abandon est à part (R2). */
export const ETAGERES_AFFICHEES = [
	{ valeur: 'a_decouvrir', libelle: 'À découvrir' },
	{ valeur: 'en_cours', libelle: 'En cours' },
	{ valeur: 'termine', libelle: 'Terminé' }
] as const;
