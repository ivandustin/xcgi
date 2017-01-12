env | grep "_FILES"
env | grep "_POST"
echo
echo MY PETS ARE:
for i in $_POST_PETS; do
	echo $i
done
