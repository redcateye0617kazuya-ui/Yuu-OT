from flask import Flask, render_template, request
import urllib.parse as urlparse

app = Flask(__name__)

# 預設變數設定
current_chat_id = "尚未設定直播"
current_video_url = ""
start_date = "2026-07-28"
start_time = "20:00"  # 保留基本開台時間
is_started = False    # 係咪禁咗 Start

@app.route('/')
def index():
    return render_template(
        'index.html', 
        chat_status=current_chat_id, 
        start_date=start_date, 
        start_time=start_time,
        video_url=current_video_url,
        is_started=str(is_started).lower()
    )

@app.route('/update_config', methods=['POST'])
def update_config():
    global current_chat_id, start_date, start_time, current_video_url, is_started
    current_video_url = request.form.get('video_url')
    start_date = request.form.get('start_date')
    start_time = request.form.get('start_time')  # 接收開台時間
    
    action = request.form.get('action')
    if action == 'start':
        is_started = True
    elif action == 'reset':
        is_started = False
    
    parsed_url = urlparse.urlparse(current_video_url)
    if parsed_url.netloc == 'youtu.be':
        video_id = parsed_url.path[1:]
    else:
        query_params = urlparse.parse_qs(parsed_url.query)
        video_id = query_params.get('v', [None])[0]
    
    if video_id:
        current_chat_id = f"已綁定 (Video ID: {video_id})"
    else:
        current_chat_id = "❌ 連結格式錯誤，請重新輸入"
        
    return render_template(
        'index.html', 
        chat_status=current_chat_id, 
        start_date=start_date, 
        start_time=start_time,
        video_url=current_video_url,
        is_started=str(is_started).lower()
    )

if __name__ == '__main__':
    app.run(debug=True, port=5000)
