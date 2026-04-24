You can build the service by running `./visp.py build session-manager` in ~/visible-speech-deployment

You can restart the service by running `./visp.py restart session-manager` in ~/visible-speech-deployment

You should build and restart the service after every change.

You can see the log by running `./visp.py logs session-manager`

Increse the version of the server in package.json when you deem it appropriate. Use semver logic; bugfixes should alter 0.0.X and new features or API changes should alter 0.X.0. But don't follow this too strictly. A very minor new feature or very minor change might not warrant a 0.X.0 change. Don't change X.0.0 unless requested by the user.

