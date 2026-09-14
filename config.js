/* ==========================================================================
   DGCL Connect mobile — configuration
   --------------------------------------------------------------------------
   Seul fichier à modifier avant la mise en ligne.

   L'identifiant client ci-dessous n'est PAS un secret : les identifiants de
   type « Application Web » sont visibles par conception dans toute page web.
   La sécurité repose sur la liste des origines autorisées, que vous déclarez
   dans Google Cloud Console, et sur le partage Google Drive.

   N'ajoutez JAMAIS de client_secret dans ce fichier.
   ========================================================================== */

window.CONFIG_DGCL = {

  // Identifiant client OAuth de type « Application Web ».
  // Google Cloud Console → API et services → Identifiants → Créer des
  // identifiants → ID client OAuth → Application Web.
  // Dans « Origines JavaScript autorisées », inscrivez l'adresse exacte de
  // votre site, par exemple : https://dgcl2026.github.io
  CLIENT_ID: "763395450910-a4evqtiqo4g1g7687a7bltmg6pjrf4er.apps.googleusercontent.com",

  // Identifiant du fichier de configuration officiel sur Google Drive
  // (valeur "sharedConfigFileId" de votre permissions.json).
  // Sans cette précision, l'application recherchait le fichier par son nom et
  // pouvait tomber sur une sauvegarde ancienne, ne contenant qu'une partie
  // des dossiers. Laissez vide pour revenir à la recherche automatique.
  FICHIER_CONFIG: "1bIeTf1IIQ2WF-pc98c4lN9CF4C97xi0z",

  // Catégories de dossiers exclues de la version mobile, quel que soit le
  // rôle de l'agent. Un téléphone se perd, se prête et se photographie :
  // les données transmises par les opérateurs n'ont pas à s'y trouver.
  CATEGORIES_EXCLUES: ["documents_confidentiels"],

  // Tout dossier dont le niveau d'accès minimal atteint ce seuil est écarté
  // de la version mobile. Double sécurité, si une nouvelle catégorie
  // confidentielle était créée sans être ajoutée à la liste ci-dessus.
  NIVEAU_EXCLU_A_PARTIR_DE: 4,

  // Verrouillage automatique après inactivité, en minutes.
  MINUTES_AVANT_VERROUILLAGE: 10,

  // Nombre de documents récents affichés dans un dossier avant pagination.
  DOCUMENTS_PAR_PAGE: 60,
};
