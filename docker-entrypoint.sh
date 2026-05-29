#!/bin/sh

# conver_to_array(){
#     local BOT_SEND_ID_env=$1
#     local IFS=","
#     str=""
#     for send_id in ${BOT_SEND_ID_env};do
#         str="$str    - ${send_id}\n"
#     done
#     result=`echo -e "${str}"`
# }
AUTOREPLY=`printf "%b" "${AUTOREPLY}"`
OPENAI_PAYLOAD=`printf "%b" "${OPENAI_PAYLOAD}"`

# if [ ! -e "/Crisp-Telegram-Bot/config.yml" ]; then
# conver_to_array ${BOT_SEND_ID}
cat > /Crisp-Telegram-Bot/config.yml << EOF
bot:
  token: ${BOT_TOKEN}
  groupId: ${BOT_GROUPID}
crisp:
  id: ${CRISP_ID}
  key: ${CRISP_KEY}
  website: ${CRISP_WEBSITE}
easyimages:
  apiUrl: ${EasyImages_apiUrl}
  apiToken: ${EasyImages_apiToken}
replyUser:
  operatorNickname: ${OPERATOR_NICKNAME:-人工客服}
  operatorAvatar: ${OPERATOR_AVATAR:-https://bpic.51yuansu.com/pic3/cover/03/47/92/65e3b3b1eb909_800.jpg}
  aiNickname: ${AI_NICKNAME:-智能客服}
  aiAvatar: ${AI_AVATAR:-https://img.ixintu.com/download/jpg/20210125/8bff784c4e309db867d43785efde1daf_512_512.jpg}
autoreply:
${AUTOREPLY}
openai:
  baseUrl: ${OPENAI_BASEURL:-https://api.openai.com/v1}
  apiKey: ${OPENAI_APIKEY}
  model: ${OPENAI_MODEL:-gpt-3.5-turbo}
  payload: |
${OPENAI_PAYLOAD}
EOF
# fi
exec "$@"
