
git fetch origin
git reset --hard origin/develop
npm run build
sudo hb-service unlink
sudo hb-service link
sudo hb-service restart
