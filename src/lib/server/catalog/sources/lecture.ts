/**
 * La lecture défensive d'une réponse de source.
 *
 * Les adaptateurs lisent du JSON qu'ils n'écrivent pas et dont le contrat peut
 * changer sans préavis. Ces accesseurs existent pour que ce changement se
 * traduise par un champ absent — donc par une complétude honnête — et jamais par
 * une exception qui ferait échouer la page, ni par un `undefined` qui se
 * faufilerait jusqu'en base.
 *
 * La leçon de méthode de la décision 001 vaut ici : un accesseur mal écrit
 * produit une mesure fausse, qui a l'air d'une réponse. D'où la règle de ce
 * fichier : **on ne devine jamais**. Une valeur du mauvais type vaut absence.
 */

export type Objet = Record<string, unknown>;

export function estObjet(valeur: unknown): valeur is Objet {
	return typeof valeur === 'object' && valeur !== null && !Array.isArray(valeur);
}

export function objet(valeur: unknown, champ: string): Objet | undefined {
	if (!estObjet(valeur)) return undefined;
	const lu = valeur[champ];
	return estObjet(lu) ? lu : undefined;
}

/** Un tableau d'objets, ou `undefined` si le champ n'est pas un tableau. */
export function liste(valeur: unknown, champ: string): Objet[] | undefined {
	if (!estObjet(valeur)) return undefined;
	const lu = valeur[champ];
	if (!Array.isArray(lu)) return undefined;
	return lu.filter(estObjet);
}

/** Une chaîne non vide, ou `undefined`. Les chaînes vides des sources valent absence. */
export function texte(valeur: unknown, champ: string): string | undefined {
	if (!estObjet(valeur)) return undefined;
	const lu = valeur[champ];
	if (typeof lu !== 'string') return undefined;
	const propre = lu.trim();
	return propre === '' ? undefined : propre;
}

/** Un identifiant de source, toujours rendu en chaîne : le modèle local les stocke ainsi. */
export function identifiant(valeur: unknown, champ = 'id'): string | undefined {
	if (!estObjet(valeur)) return undefined;
	const lu = valeur[champ];
	if (typeof lu === 'number' && Number.isFinite(lu)) return String(lu);
	if (typeof lu === 'string' && lu.trim() !== '') return lu.trim();
	return undefined;
}

/**
 * Un rang dans une série, depuis ce que la source en dit.
 *
 * Metron rend le numéro en chaîne, et tous ne sont pas des nombres : « 1.MU »,
 * « Annual 2 », « ½ » existent. Un numéro qu'on ne sait pas lire vaut absence
 * plutôt qu'une approximation — la réconciliation s'appuie dessus, et un rang
 * inventé y ferait fusionner deux œuvres distinctes.
 */
export function rang(valeur: unknown, champ: string): number | undefined {
	if (!estObjet(valeur)) return undefined;
	const lu = valeur[champ];
	if (typeof lu === 'number') return Number.isFinite(lu) ? lu : undefined;
	if (typeof lu !== 'string') return undefined;
	if (!/^\d+(\.\d+)?$/.test(lu.trim())) return undefined;
	return Number(lu.trim());
}

/**
 * Une date de parution en ISO 8601, jour compris quand la source le donne.
 *
 * Même sévérité que `reconcile.ts` : une date qu'on ne sait pas lire vaut date
 * absente. Une date inventée ferait rapprocher deux numéros qui n'ont rien à
 * voir, ce qui est une perte de données là où l'absence n'est qu'un doublon.
 */
export function dateIso(valeur: unknown, champ: string): string | undefined {
	const lu = texte(valeur, champ);
	if (lu === undefined) return undefined;
	return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(lu) ? lu : undefined;
}
