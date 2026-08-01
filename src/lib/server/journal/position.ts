import { estAtteinte, type EtatDeLecture } from './atteinte';

/**
 * L'avancement à l'intérieur d'une œuvre longue : la saisie (R23) et la règle
 * qui dit ce que vaut la position (R24).
 *
 * **La position est stockée normalisée, en fraction de l'œuvre.** R23 autorise
 * la saisie en page ou en pourcentage ; la page n'est qu'une conversion à
 * l'entrée. Sans cette normalisation, R29 — que U6 implémentera — ne peut pas
 * comparer la position d'un lecteur à celle de l'auteur d'un commentaire saisi
 * dans l'autre unité, et le masquage intra-œuvre devient un tirage au sort.
 *
 * L'échelle retenue est `[0, 1]` et non `[0, 100]`. Une seule échelle, choisie
 * une fois : les deux se valent, mais deux se rencontreraient un jour dans une
 * comparaison et personne ne verrait laquelle est laquelle. L'affichage
 * multiplie par cent, c'est son affaire.
 */

export const POSITION_MIN = 0;
export const POSITION_MAX = 1;

/**
 * Une saisie de membre, avant normalisation.
 *
 * `longueurTotale` est la longueur de l'édition **que ce membre lit**. Elle
 * accompagne la saisie parce que c'est le membre qui la connaît : deux membres
 * lisant deux éditions du même roman n'ont pas la même pagination, et le
 * catalogue ne porte pas cette donnée — les sources ne la fournissent pas de
 * façon fiable, et elle n'appartient pas à l'œuvre mais à l'exemplaire.
 */
export type SaisieDePosition =
	| { unite: 'pourcentage'; valeur: number }
	| { unite: 'page'; valeur: number; longueurTotale?: number | null };

export type MotifRefusPosition = 'valeur invalide' | 'hors bornes' | 'longueur inconnue';

export type ResultatPosition =
	| { ok: true; position: number; longueurTotale: number | null }
	| { ok: false; motif: MotifRefusPosition };

/**
 * Normalise une saisie. Fonction pure — c'est elle qui porte la règle de R23,
 * et c'est elle qu'on teste.
 *
 * Une saisie en pages sans longueur connue est **refusée**, jamais devinée. Une
 * conversion approximative produirait une position fausse mais plausible, que
 * plus rien ensuite ne pourrait distinguer d'une position juste — et c'est sur
 * cette position que R29 décidera de masquer ou non un texte.
 *
 * `options.longueurTotale` est la longueur déjà connue de l'entrée : le membre
 * ne la redéclare pas à chaque page tournée.
 */
export function normaliserPosition(
	saisie: SaisieDePosition,
	options: { longueurTotale?: number | null } = {}
): ResultatPosition {
	if (!Number.isFinite(saisie.valeur)) return { ok: false, motif: 'valeur invalide' };

	if (saisie.unite === 'pourcentage') {
		if (saisie.valeur < 0 || saisie.valeur > 100) return { ok: false, motif: 'hors bornes' };
		return { ok: true, position: saisie.valeur / 100, longueurTotale: null };
	}

	const longueur = saisie.longueurTotale ?? options.longueurTotale ?? null;
	if (longueur === null || !Number.isFinite(longueur) || longueur <= 0) {
		return { ok: false, motif: 'longueur inconnue' };
	}
	if (saisie.valeur < 0 || saisie.valeur > longueur) return { ok: false, motif: 'hors bornes' };

	return { ok: true, position: saisie.valeur / longueur, longueurTotale: longueur };
}

/**
 * R24 — la position d'un membre dans une œuvre est nulle si l'œuvre n'est pas
 * commencée, totale si elle est atteinte, et égale à la dernière valeur
 * déclarée si elle est en cours.
 *
 * La valeur déclarée est conservée telle quelle sous l'atteinte plutôt
 * qu'écrasée : reprendre une œuvre abandonnée (R35) la fait cesser d'être
 * atteinte, et le membre retrouve alors l'avancement qu'il avait déclaré. Une
 * remise à zéro à l'abandon lui ferait perdre cette information sans retour.
 */
export function positionEffective(
	etat: EtatDeLecture | null,
	positionDeclaree: number | null
): number {
	if (etat === null) return POSITION_MIN;
	if (estAtteinte(etat)) return POSITION_MAX;
	if (etat.etagere === 'a_decouvrir') return POSITION_MIN;
	return positionDeclaree ?? POSITION_MIN;
}
