# 001 — Choix des sources de données

**Statut : tranché sur les données, sauf la licence.** Mesuré le 2026-08-01 avec `node --env-file=.dev.vars scripts/sondes.js`.

## Décision

**Metron est la source primaire pour les comics. TMDB pour les films et séries. Comic Vine est écartée.**

La dimension personnage du graphe est **conservée** : le seuil de 70 % fixé avant la mesure est franchi avec 83 % sur le post-2000.

## Ce qui a été établi

**L'API développeur Marvel n'existe plus.** Vérifié par appel direct : `developer.marvel.com` redirige vers le site grand public, et `gateway.marvel.com` renvoie une erreur serveur là où une requête sans clé devrait être refusée avec un code dédié. Ce n'est pas une dégradation, c'est une disparition.

**Comic Vine est écartée pour deux raisons qui se cumulent.** La clé n'a pas pu être obtenue malgré la création d'un compte — ce qui est cohérent avec ce que la recherche annonçait : rachat par Fandom, licenciements répétés chez GameSpot, panne de six jours en 2024, « aucune présence développeur depuis des années ». Et surtout elle est devenue **inutile** : Metron passe le seuil seule. La source au meilleur champ de données était aussi celle au pire pronostic de pérennité ; ne pas en dépendre est un gain, pas un renoncement.

## Les mesures

### Metron — comics

| Décennie   | Couverture personnages |
| ---------- | ---------------------- |
| 1960       | 3/3 (100 %)            |
| 1980       | 2/3 (67 %)             |
| 2000       | 2/3 (67 %)             |
| 2020       | 3/3 (100 %)            |
| **Global** | **10/11 (91 %)**       |

- **Post-2000 : 83 %** — au-dessus du seuil de 70 %, la dimension personnage tient
- **Médiane de 10,5 crédits par numéro** — c'est le chiffre qui borne le volume d'écriture du graphe (KTD4). Une douzaine de lignes d'appui par consignation, très loin des plafonds Cloudflare
- **Parcours par personnage : exposé** (`/api/character/{id}/`)
- Sert aussi les **crédits créateurs** (médiane autour de 10) et les **arcs narratifs**
- Latence maximale observée : 1742 ms

**Débit — la contrainte la plus dure.** Metron étrangle vers la dizaine d'appels consécutifs et renvoie un 429 annonçant le délai dans le corps de la réponse (« Expected available in 12 seconds »). Une cadence de **2,5 s entre appels** passe sans incident. C'est une contrainte structurante pour l'ingestion en cascade : un recueil de quarante numéros ne peut pas être ingéré d'un trait, ce que le fractionnement de U5 prévoyait déjà.

### TMDB — films et séries

- 4/4 trouvés, **affiches disponibles** pour tous
- Latence maximale : 527 ms, sans étranglement observé
- Médiane de 78 au casting

**Nuance importante : le casting TMDB liste des acteurs, pas des personnages de fiction.** Il ne nourrit donc pas la dimension personnage du graphe au sens de R49. Les films entreront dans le graphe par leur série et leur event, pas par leurs personnages — sauf à rapprocher un acteur de son rôle, ce qui est un autre travail.

### Composition des recueils

Metron modélise les recueils comme des **séries de type « trade paperback »** plutôt que comme un type d'œuvre distinct. Trois requêtes de contrôle trouvent bien les séries correspondantes, mais **la liste des numéros contenus reste à confirmer sur une fiche précise** — c'est la donnée dont dépend toute la cascade de U5, et elle n'est pas encore vérifiée.

## Ce qui reste ouvert, et qui peut tout changer

**Les licences n'ont pas été lues.** C'était la première des cinq questions de U1 et elle n'est pas tranchée. Trois points à vérifier avant que U3b ne persiste quoi que ce soit durablement :

| Question                                        | Metron | TMDB   |
| ----------------------------------------------- | ------ | ------ |
| Stocker les données dans une application privée | à lire | à lire |
| Mettre en cache les couvertures et affiches     | à lire | à lire |
| Obligations d'attribution exactes               | à lire | à lire |

C'est le seul point qui pourrait encore invalider l'architecture. Une interdiction de stockage local reviendrait à interdire l'ingestion paresseuse de KTD1 ; une interdiction de cache des visuels obligerait à pointer les URL des sources, ce que l'architecture actuelle — sans stockage d'objets — impose de toute façon pour l'instant.

## Une leçon de méthode, gardée volontairement

La **première** exécution des sondes a conclu à **0 % de couverture personnages** et recommandé d'amputer le graphe de sa dimension principale.

Elle était fausse. Le script interrogeait Metron sur `name`, qui cherche dans le _titre de l'histoire_ et non dans le nom de la série ; il tombait sur des numéros obscurs que la communauté n'a pas indexés, et concluait à l'absence d'une donnée qui était là. Le bon paramètre est `series_name`.

**Une mesure fausse est pire qu'une mesure absente : elle a l'air d'une réponse.** Sans vérification de la forme réelle de la réponse, la dimension personnage du graphe aurait été supprimée sur la foi d'un accesseur mal écrit. Le commentaire en tête de `scripts/sondes.js` garde la trace de l'épisode.
